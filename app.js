// ============================================
// CHAMPAGNE INVENTORY - SÉCURISÉ
// QR Codes • Photos • Export CSV • Marques/Gammes
// ============================================

const DB_NAME = 'ChampagneInventoryDB';
const DB_VERSION = 1;
const STORES = {
    USERS: 'users',
    BRANDS: 'brands',
    ITEMS: 'items',
    LOGS: 'securityLogs',
    SESSIONS: 'sessions'
};

const ADMIN_CODE = 'CHAMPAGNE2024!';
const SESSION_TIMEOUT = 30 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;

let db = null;
let currentUser = null;
let currentSession = null;
let currentBrandId = null;
let currentItemId = null;
let currentGammeFilter = 'all';
let enteredPin = '';
let currentPhoto = null;
let currentQRCode = null;

const gammeLabels = {
    brut: 'Brut',
    rose: 'Rosé',
    'blanc-de-blancs': 'Blanc de Blancs',
    millessime: 'Millésimé',
    prestige: 'Prestige',
    'demi-sec': 'Demi-sec',
    autre: 'Autre'
};

const gammeEmojis = {
    brut: '🥂',
    rose: '🌸',
    'blanc-de-blancs': '🤍',
    millessime: '📅',
    prestige: '👑',
    'demi-sec': '🍯',
    autre: '🍾'
};

// ============================================
// QR CODE GENERATOR (Simple SVG Pattern)
// ============================================

function generateQRCodeData(text) {
    // Génère un pattern QR-like en SVG basé sur le hash du texte
    const hash = hashString(text);
    let svg = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<rect width="100" height="100" fill="white"/>`;

    // Position detection patterns (corners)
    const corners = [[0,0], [70,0], [0,70]];
    for (const [cx, cy] of corners) {
        svg += `<rect x="${cx}" y="${cy}" width="25" height="25" fill="black"/>`;
        svg += `<rect x="${cx+5}" y="${cy+5}" width="15" height="15" fill="white"/>`;
        svg += `<rect x="${cx+8}" y="${cy+8}" width="9" height="9" fill="black"/>`;
    }

    // Data pattern based on hash
    const seed = parseInt(hash.substring(0, 8), 16);
    for (let i = 0; i < 100; i++) {
        const x = (i * 7 + seed) % 100;
        const y = (i * 13 + seed) % 100;
        const size = ((seed >> (i % 16)) & 3) + 2;
        // Skip corners
        if ((x < 28 && y < 28) || (x > 67 && y < 28) || (x < 28 && y > 67)) continue;
        if (x + size > 100 || y + size > 100) continue;
        svg += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="black"/>`;
    }

    svg += `</svg>`;
    return svg;
}

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
}

function generateUniqueCode() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `CH-${timestamp}-${random}`;
}

// ============================================
// INITIALISATION DB
// ============================================

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { db = request.result; resolve(db); };
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORES.USERS)) {
                const s = database.createObjectStore(STORES.USERS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('email', 'email', { unique: true });
                s.createIndex('role', 'role', { unique: false });
            }
            if (!database.objectStoreNames.contains(STORES.BRANDS)) {
                const s = database.createObjectStore(STORES.BRANDS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('name', 'name', { unique: false });
                s.createIndex('userId', 'userId', { unique: false });
            }
            if (!database.objectStoreNames.contains(STORES.ITEMS)) {
                const s = database.createObjectStore(STORES.ITEMS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('name', 'name', { unique: false });
                s.createIndex('brandId', 'brandId', { unique: false });
                s.createIndex('qrCode', 'qrCode', { unique: true });
                s.createIndex('userId', 'userId', { unique: false });
            }
            if (!database.objectStoreNames.contains(STORES.LOGS)) {
                const s = database.createObjectStore(STORES.LOGS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('timestamp', 'timestamp', { unique: false });
                s.createIndex('type', 'type', { unique: false });
            }
            if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
                const s = database.createObjectStore(STORES.SESSIONS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('userId', 'userId', { unique: false });
                s.createIndex('token', 'token', { unique: true });
            }
        };
    });
}

// ============================================
// CRYPTO & SÉCURITÉ
// ============================================

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// INFOS SYSTÈME
// ============================================

function getDeviceInfo() {
    const ua = navigator.userAgent;
    let device = 'Inconnu', os = 'Inconnu';
    if (/Android/.test(ua)) { device = 'Android'; os = ua.match(/Android\s([\d.]+)/)?.[1] || 'Android'; }
    else if (/iPhone|iPad|iPod/.test(ua)) { device = 'iOS'; os = ua.match(/OS\s([\d_]+)/)?.[1]?.replace(/_/g, '.') || 'iOS'; }
    else if (/Windows/.test(ua)) { device = 'Windows'; os = ua.match(/Windows\sNT\s([\d.]+)/)?.[1] || 'Windows'; }
    else if (/Mac/.test(ua)) { device = 'Mac'; os = 'macOS'; }
    else if (/Linux/.test(ua)) { device = 'Linux'; os = 'Linux'; }
    const browser = /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : /Edge/.test(ua) ? 'Edge' : 'Inconnu';
    return { device, os, browser, userAgent: ua, screen: `${screen.width}x${screen.height}`, language: navigator.language };
}

async function getIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        const data = await response.json();
        return data.ip;
    } catch { return '127.0.0.1'; }
}

// ============================================
// LOGS DE SÉCURITÉ
// ============================================

async function logSecurityEvent(type, identifier, status, details = {}) {
    const deviceInfo = getDeviceInfo();
    const ip = await getIP();
    const log = {
        timestamp: Date.now(),
        type, identifier, status, ip,
        device: deviceInfo.device,
        os: deviceInfo.os,
        browser: deviceInfo.browser,
        screen: deviceInfo.screen,
        language: deviceInfo.language,
        userAgent: deviceInfo.userAgent.substring(0, 200),
        details,
        userId: currentUser?.id || null
    };
    await addToStore(STORES.LOGS, log);
}

// ============================================
// DB GÉNÉRIQUE
// ============================================

function addToStore(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.add(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getFromStore(storeName, id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function updateInStore(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function deleteFromStore(storeName, id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function getByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.get(value);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ============================================
// AUTHENTIFICATION
// ============================================

function switchTab(tab) {
    document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
    document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
    document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
    hideAuthError();
}

function showAuthError(message) {
    document.getElementById('authErrorText').textContent = message;
    document.getElementById('authError').classList.add('show');
}

function hideAuthError() {
    document.getElementById('authError').classList.remove('show');
}

function checkPasswordStrength() {
    const password = document.getElementById('regPassword').value;
    const fill = document.getElementById('passwordStrength');
    let strength = 0;
    if (password.length >= 8) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++;
    fill.className = 'password-strength-fill';
    if (strength <= 1) fill.classList.add('strength-weak');
    else if (strength <= 3) fill.classList.add('strength-medium');
    else fill.classList.add('strength-strong');
}

async function handleRegister() {
    hideAuthError();

    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const password = document.getElementById('regPassword').value;
    const passwordConfirm = document.getElementById('regPasswordConfirm').value;
    const adminCode = document.getElementById('regAdminCode').value;

    if (!name || !email || !password) {
        showAuthError('Tous les champs obligatoires doivent être remplis');
        return;
    }

    if (password !== passwordConfirm) {
        showAuthError('Les mots de passe ne correspondent pas');
        await logSecurityEvent('register', email, 'fail', { reason: 'password_mismatch' });
        return;
    }

    if (password.length < 8) {
        showAuthError('Le mot de passe doit faire au moins 8 caractères');
        await logSecurityEvent('register', email, 'fail', { reason: 'password_too_short' });
        return;
    }

    const existingUser = await getByIndex(STORES.USERS, 'email', email);
    if (existingUser) {
        showAuthError('Un compte existe déjà avec cet email');
        await logSecurityEvent('register', email, 'fail', { reason: 'email_exists' });
        return;
    }

    const role = (adminCode === ADMIN_CODE) ? 'admin' : 'user';
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    const user = {
        name, email, passwordHash, salt, role,
        createdAt: Date.now(),
        lastLogin: null,
        loginAttempts: 0,
        lockedUntil: null,
        pin: null
    };

    const userId = await addToStore(STORES.USERS, user);
    await logSecurityEvent('register', email, 'success', { userId, role });

    showToast('✅ Compte créé ! Connectez-vous');
    switchTab('login');
    document.getElementById('loginEmail').value = email;
}

async function handleLogin() {
    hideAuthError();

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
        showAuthError('Veuillez remplir tous les champs');
        return;
    }

    const user = await getByIndex(STORES.USERS, 'email', email);

    if (!user) {
        showAuthError('Email ou mot de passe incorrect');
        await logSecurityEvent('login_attempt', email, 'fail', { reason: 'user_not_found' });
        return;
    }

    if (user.lockedUntil && Date.now() < user.lockedUntil) {
        const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
        showAuthError(`Compte verrouillé. Réessayez dans ${remaining} minutes`);
        await logSecurityEvent('login_attempt', email, 'blocked', { reason: 'account_locked', remaining });
        return;
    }

    const passwordHash = await hashPassword(password, user.salt);

    if (passwordHash !== user.passwordHash) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;
        if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
            user.lockedUntil = Date.now() + LOCKOUT_DURATION;
            showAuthError(`Trop de tentatives. Compte verrouillé 15 minutes`);
            await logSecurityEvent('login_attempt', email, 'blocked', { reason: 'max_attempts', attempts: user.loginAttempts });
        } else {
            showAuthError(`Email ou mot de passe incorrect (${MAX_LOGIN_ATTEMPTS - user.loginAttempts} essais restants)`);
            await logSecurityEvent('login_attempt', email, 'fail', { reason: 'wrong_password', attempts: user.loginAttempts });
        }
        await updateInStore(STORES.USERS, user);
        return;
    }

    user.loginAttempts = 0;
    user.lockedUntil = null;
    user.lastLogin = Date.now();
    await updateInStore(STORES.USERS, user);

    const token = generateToken();
    const session = {
        userId: user.id, token,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        device: getDeviceInfo()
    };
    await addToStore(STORES.SESSIONS, session);

    const encryptedToken = btoa(JSON.stringify({ token, userId: user.id, salt: user.salt }));
    localStorage.setItem('champagneSession', encryptedToken);

    await logSecurityEvent('login_attempt', email, 'success', { userId: user.id, role: user.role });

    currentUser = user;
    if (!user.pin) {
        showSetPinScreen();
    } else {
        startSession(user);
    }
}

async function checkExistingSession() {
    const encryptedToken = localStorage.getItem('champagneSession');
    if (!encryptedToken) return false;

    try {
        const sessions = await getAllFromStore(STORES.SESSIONS);
        if (sessions.length > 0) {
            const lastSession = sessions[sessions.length - 1];
            const user = await getFromStore(STORES.USERS, lastSession.userId);
            if (user) {
                currentUser = user;
                showLockScreen();
                return true;
            }
        }
    } catch (e) { console.error(e); }
    return false;
}

// ============================================
// PIN & VERROUILLAGE
// ============================================

function showSetPinScreen() {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('brandsScreen').classList.remove('active');
    document.querySelector('.lock-title').textContent = 'Définir un code PIN';
    document.querySelector('.lock-subtitle').textContent = '4 chiffres pour verrouiller';
    enteredPin = '';
    updatePinDots();
}

function showLockScreen() {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('brandsScreen').classList.remove('active');
    document.getElementById('brandDetailScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');
    document.getElementById('lockUserName').textContent = currentUser?.name || '';
    document.querySelector('.lock-title').textContent = 'Session verrouillée';
    document.querySelector('.lock-subtitle').textContent = 'Entrez votre code PIN';
    enteredPin = '';
    updatePinDots();
}

function enterPin(digit) {
    if (enteredPin.length < 4) {
        enteredPin += digit;
        updatePinDots();
        if (enteredPin.length === 4) setTimeout(() => validatePin(), 200);
    }
}

function clearPin() {
    enteredPin = enteredPin.slice(0, -1);
    updatePinDots();
}

function updatePinDots() {
    document.querySelectorAll('.pin-dot').forEach((dot, i) => {
        dot.classList.toggle('filled', i < enteredPin.length);
    });
}

async function validatePin() {
    if (!currentUser) return;

    if (!currentUser.pin) {
        const salt = generateSalt();
        const pinHash = await hashPassword(enteredPin, salt);
        currentUser.pin = pinHash;
        currentUser.pinSalt = salt;
        await updateInStore(STORES.USERS, currentUser);
        showToast('✅ PIN défini !');
        startSession(currentUser);
        return;
    }

    const pinHash = await hashPassword(enteredPin, currentUser.pinSalt);
    if (pinHash === currentUser.pin) {
        startSession(currentUser);
    } else {
        showToast('❌ PIN incorrect');
        enteredPin = '';
        updatePinDots();
        await logSecurityEvent('pin_unlock', currentUser.email, 'fail', { reason: 'wrong_pin' });
    }
}

function lockSession() {
    toggleMenu();
    showLockScreen();
    logSecurityEvent('lock', currentUser?.email, 'success', {});
}

// ============================================
// SESSION
// ============================================

function startSession(user) {
    currentUser = user;
    currentSession = { startTime: Date.now() };

    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('brandsScreen').classList.add('active');

    document.getElementById('headerUserName').textContent = user.name;
    document.getElementById('menuUserName').textContent = user.name;
    document.getElementById('menuUserRole').textContent = user.role === 'admin' ? 'Administrateur' : 'Utilisateur';

    if (user.role === 'admin') {
        document.getElementById('headerAdminBadge').style.display = 'inline';
        document.getElementById('headerAdminBadge2').style.display = 'inline';
        document.getElementById('menuAdminItem').style.display = 'flex';
    } else {
        document.getElementById('headerAdminBadge').style.display = 'none';
        document.getElementById('headerAdminBadge2').style.display = 'none';
        document.getElementById('menuAdminItem').style.display = 'none';
    }

    loadBrands();

    setInterval(() => {
        if (currentSession && Date.now() - currentSession.startTime > SESSION_TIMEOUT) {
            showToast('⏱️ Session expirée');
            lockSession();
        }
    }, 60000);
}

async function logout() {
    if (currentUser) await logSecurityEvent('logout', currentUser.email, 'success', {});
    currentUser = null;
    currentSession = null;
    localStorage.removeItem('champagneSession');
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('brandsScreen').classList.remove('active');
    document.getElementById('brandDetailScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');
    document.getElementById('authScreen').style.display = 'flex';
    showToast('👋 Déconnecté');
}

// ============================================
// NAVIGATION
// ============================================

function toggleMenu() {
    document.getElementById('menuOverlay').classList.toggle('active');
    document.getElementById('sideMenu').classList.toggle('active');
}

function showScreen(screen) {
    document.getElementById('brandsScreen').classList.remove('active');
    document.getElementById('brandDetailScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');

    if (screen === 'brands') {
        document.getElementById('brandsScreen').classList.add('active');
        loadBrands();
    } else if (screen === 'brandDetail') {
        document.getElementById('brandDetailScreen').classList.add('active');
    } else if (screen === 'admin') {
        if (currentUser?.role !== 'admin') {
            showToast('❌ Accès refusé');
            return;
        }
        document.getElementById('adminScreen').classList.add('active');
        loadAdminData();
    }
}

// ============================================
// BRANDS (MAISONS)
// ============================================

async function loadBrands() {
    if (!currentUser) return;
    const brands = await getAllFromStore(STORES.BRANDS);
    const userBrands = currentUser.role === 'admin' ? brands : brands.filter(b => b.userId === currentUser.id);
    renderBrands(userBrands);
    updateBrandStats(userBrands);
}

function renderBrands(brands) {
    const container = document.getElementById('brandsContainer');
    const search = document.getElementById('brandSearchInput').value.toLowerCase();

    let filtered = brands;
    if (search) filtered = filtered.filter(b => b.name.toLowerCase().includes(search));

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">🍾</div>
                <h3>${brands.length === 0 ? 'Aucune maison' : 'Aucun résultat'}</h3>
                <p>${brands.length === 0 ? 'Ajoutez votre première maison de champagne' : 'Essayez une autre recherche'}</p>
            </div>`;
        return;
    }

    container.innerHTML = filtered.map(brand => `
        <div class="brand-card" onclick="openBrandDetail(${brand.id})">
            <div class="brand-icon">🍾</div>
            <div class="brand-name">${escapeHtml(brand.name)}</div>
            <div class="brand-count">${brand.itemCount || 0} produits</div>
            <div class="brand-value">${(brand.totalValue || 0).toFixed(0)}€</div>
        </div>
    `).join('');
}

async function updateBrandStats(brands) {
    const items = await getAllFromStore(STORES.ITEMS);
    const userItems = currentUser.role === 'admin' ? items : items.filter(i => i.userId === currentUser.id);

    let totalBottles = 0;
    let totalValue = 0;

    for (const brand of brands) {
        const brandItems = userItems.filter(i => i.brandId === brand.id);
        brand.itemCount = brandItems.length;
        brand.totalBottles = brandItems.reduce((sum, i) => sum + (i.quantity || 0), 0);
        brand.totalValue = brandItems.reduce((sum, i) => sum + ((i.priceExport || 0) * (i.quantity || 0)), 0);
        totalBottles += brand.totalBottles;
        totalValue += brand.totalValue;
    }

    document.getElementById('totalBrands').textContent = brands.length;
    document.getElementById('totalBottles').textContent = totalBottles;
    document.getElementById('totalStockValue').textContent = totalValue.toFixed(0) + '€';
}

function filterBrands() {
    loadBrands();
}

function openBrandModal() {
    document.getElementById('brandModalTitle').textContent = 'Nouvelle Maison';
    document.getElementById('brandName').value = '';
    document.getElementById('brandDescription').value = '';
    document.getElementById('brandModalOverlay').classList.add('active');
}

function closeBrandModal() {
    document.getElementById('brandModalOverlay').classList.remove('active');
}

async function saveBrand() {
    const name = document.getElementById('brandName').value.trim();
    const description = document.getElementById('brandDescription').value.trim();

    if (!name) {
        showToast('❌ Le nom est obligatoire');
        return;
    }

    const brand = {
        name, description,
        userId: currentUser.id,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    await addToStore(STORES.BRANDS, brand);
    await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'create_brand', brandName: name });

    closeBrandModal();
    loadBrands();
    showToast('✅ Maison ajoutée');
}

// ============================================
// BRAND DETAIL & ITEMS
// ============================================

async function openBrandDetail(brandId) {
    currentBrandId = brandId;
    const brand = await getFromStore(STORES.BRANDS, brandId);
    if (!brand) return;

    document.getElementById('currentBrandName').textContent = brand.name;
    document.getElementById('brandDetailTitle').textContent = brand.name;

    // Populate brand select in item modal
    const brandSelect = document.getElementById('itemBrand');
    brandSelect.innerHTML = `<option value="${brandId}">${brand.name}</option>`;

    showScreen('brandDetail');
    loadBrandItems();
}

async function loadBrandItems() {
    if (!currentBrandId) return;
    const items = await getAllFromStore(STORES.ITEMS);
    const brandItems = items.filter(i => i.brandId === currentBrandId);

    const brand = await getFromStore(STORES.BRANDS, currentBrandId);
    const totalBottles = brandItems.reduce((sum, i) => sum + (i.quantity || 0), 0);
    document.getElementById('currentBrandStats').textContent = `${brandItems.length} produits • ${totalBottles} bouteilles`;

    renderBrandItems(brandItems);
}

function renderBrandItems(items) {
    const container = document.getElementById('brandItemsContainer');
    const search = document.getElementById('itemSearchInput').value.toLowerCase();

    let filtered = items;
    if (search) {
        filtered = filtered.filter(i => 
            i.name.toLowerCase().includes(search) ||
            (i.sku && i.sku.toLowerCase().includes(search))
        );
    }
    if (currentGammeFilter !== 'all') {
        filtered = filtered.filter(i => i.gamme === currentGammeFilter);
    }

    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">🍾</div>
                <h3>${items.length === 0 ? 'Aucun produit' : 'Aucun résultat'}</h3>
                <p>${items.length === 0 ? 'Ajoutez votre premier champagne' : 'Essayez une autre recherche'}</p>
            </div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const stockPercent = item.minStock > 0 ? Math.min((item.quantity / item.minStock) * 100, 100) : 100;
        let stockClass = 'high';
        if (stockPercent < 30) stockClass = 'low';
        else if (stockPercent < 70) stockClass = 'medium';
        const isLow = item.quantity <= (item.minStock || 0);

        const qrSvg = generateQRCodeData(item.qrCode || '');

        return `
            <div class="item-card" onclick="openSheet(${item.id})">
                <div class="item-image">
                    ${item.photo ? `<img src="${item.photo}" alt="">` : (gammeEmojis[item.gamme] || '🍾')}
                </div>
                <div class="item-info">
                    <div class="item-name">${escapeHtml(item.name)} ${isLow ? '⚠️' : ''}</div>
                    <div class="item-brand">${gammeLabels[item.gamme] || 'Autre'} ${item.vintage ? `• ${item.vintage}` : ''}</div>
                    <div class="item-meta">
                        ${item.sku ? `<span class="item-sku">${escapeHtml(item.sku)}</span>` : ''}
                    </div>
                    <div class="item-stock">
                        <div class="stock-bar"><div class="stock-fill ${stockClass}" style="width:${stockPercent}%"></div></div>
                        <span class="stock-text">${item.quantity} bt</span>
                    </div>
                    <div class="item-prices">
                        <div class="price-public">
                            <div class="price-label">Public</div>
                            <div>${item.pricePublic?.toFixed(2) || '0.00'}€</div>
                        </div>
                        <div class="price-export">
                            <div class="price-label">Export</div>
                            <div>${item.priceExport?.toFixed(2) || '0.00'}€</div>
                        </div>
                    </div>
                </div>
                <div class="item-qr">${qrSvg}</div>
            </div>
        `;
    }).join('');
}

function filterBrandItems() {
    loadBrandItems();
}

function setGammeFilter(gamme) {
    currentGammeFilter = gamme;
    document.querySelectorAll('#filterPanel .filter-chip').forEach(chip => chip.classList.remove('active'));
    event.target.classList.add('active');
    loadBrandItems();
}

function toggleFilters() {
    document.getElementById('filterPanel').classList.toggle('open');
    document.getElementById('filterBtn').classList.toggle('active');
}

// ============================================
// ITEM MODAL & PHOTOS
// ============================================

function openItemModal(item = null) {
    const overlay = document.getElementById('itemModalOverlay');
    const title = document.getElementById('itemModalTitle');

    // Reset photo
    currentPhoto = null;
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoPreview').src = '';
    document.getElementById('photoUpload').classList.remove('has-photo');
    document.getElementById('photoUploadText').style.display = 'block';

    if (item) {
        title.textContent = 'Modifier Champagne';
        document.getElementById('itemId').value = item.id;
        document.getElementById('itemName').value = item.name;
        document.getElementById('itemBrand').value = item.brandId;
        document.getElementById('itemGamme').value = item.gamme;
        document.getElementById('itemQuantity').value = item.quantity;
        document.getElementById('itemMinStock').value = item.minStock || '';
        document.getElementById('itemVintage').value = item.vintage || '';
        document.getElementById('itemPricePublic').value = item.pricePublic || '';
        document.getElementById('itemPriceExport').value = item.priceExport || '';
        document.getElementById('itemSku').value = item.sku || '';
        document.getElementById('itemDescription').value = item.description || '';

        if (item.photo) {
            currentPhoto = item.photo;
            document.getElementById('photoPreview').src = item.photo;
            document.getElementById('photoPreview').style.display = 'block';
            document.getElementById('photoUpload').classList.add('has-photo');
            document.getElementById('photoUploadText').style.display = 'none';
        }
    } else {
        title.textContent = 'Nouveau Champagne';
        document.getElementById('itemForm')?.reset?.();
        document.getElementById('itemId').value = '';
        // Set default brand
        if (currentBrandId) document.getElementById('itemBrand').value = currentBrandId;
    }

    overlay.classList.add('active');
}

function closeItemModal() {
    document.getElementById('itemModalOverlay').classList.remove('active');
}

function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        currentPhoto = e.target.result;
        document.getElementById('photoPreview').src = currentPhoto;
        document.getElementById('photoPreview').style.display = 'block';
        document.getElementById('photoUpload').classList.add('has-photo');
        document.getElementById('photoUploadText').style.display = 'none';
    };
    reader.readAsDataURL(file);
}

function removePhoto(event) {
    event.stopPropagation();
    currentPhoto = null;
    document.getElementById('photoPreview').src = '';
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoUpload').classList.remove('has-photo');
    document.getElementById('photoUploadText').style.display = 'block';
    document.getElementById('itemPhotoInput').value = '';
}

async function saveItem() {
    if (!currentUser) return;

    const id = document.getElementById('itemId').value;
    const name = document.getElementById('itemName').value.trim();
    const brandId = parseInt(document.getElementById('itemBrand').value);

    if (!name || !brandId) {
        showToast('❌ Nom et maison sont obligatoires');
        return;
    }

    const item = {
        name,
        brandId,
        gamme: document.getElementById('itemGamme').value,
        quantity: parseInt(document.getElementById('itemQuantity').value) || 0,
        minStock: parseInt(document.getElementById('itemMinStock').value) || 0,
        vintage: parseInt(document.getElementById('itemVintage').value) || null,
        pricePublic: parseFloat(document.getElementById('itemPricePublic').value) || 0,
        priceExport: parseFloat(document.getElementById('itemPriceExport').value) || 0,
        sku: document.getElementById('itemSku').value.trim(),
        description: document.getElementById('itemDescription').value.trim(),
        photo: currentPhoto,
        userId: currentUser.id,
        updatedAt: Date.now()
    };

    try {
        if (id) {
            item.id = parseInt(id);
            const existing = await getFromStore(STORES.ITEMS, item.id);
            item.qrCode = existing.qrCode; // Keep existing QR
            item.createdAt = existing.createdAt;
            await updateInStore(STORES.ITEMS, item);
            showToast('✅ Produit modifié');
            await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'update_item', itemId: item.id });
        } else {
            item.createdAt = Date.now();
            item.qrCode = generateUniqueCode();
            const newId = await addToStore(STORES.ITEMS, item);
            showToast('✅ Produit ajouté');
            await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'create_item', itemId: newId, qrCode: item.qrCode });
        }

        closeItemModal();
        await loadBrandItems();
        await loadBrands(); // Update stats
    } catch (error) {
        console.error(error);
        showToast('❌ Erreur lors de la sauvegarde');
    }
}

// ============================================
// QR CODE
// ============================================

async function showQRCode() {
    if (!currentItemId) return;
    const items = await getAllFromStore(STORES.ITEMS);
    const item = items.find(i => i.id === currentItemId);
    if (!item) return;

    closeSheet();

    const qrSvg = generateQRCodeData(item.qrCode);
    currentQRCode = { svg: qrSvg, code: item.qrCode, itemName: item.name };

    document.getElementById('qrProductInfo').textContent = `${item.name} (${item.qrCode})`;
    document.getElementById('qrDisplay').innerHTML = qrSvg;
    document.getElementById('qrCodeText').textContent = item.qrCode;
    document.getElementById('qrModalOverlay').classList.add('active');
}

function closeQrModal() {
    document.getElementById('qrModalOverlay').classList.remove('active');
}

function downloadQR() {
    if (!currentQRCode) return;

    const svg = currentQRCode.svg;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
        canvas.width = 400;
        canvas.height = 400;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 400, 400);
        ctx.drawImage(img, 0, 0, 400, 400);

        const link = document.createElement('a');
        link.download = `QR-${currentQRCode.code}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        URL.revokeObjectURL(url);
    };
    img.src = url;
}

// ============================================
// SCANNER
// ============================================

function openScanner() {
    document.getElementById('scannerOverlay').classList.add('active');
    document.getElementById('manualQrInput').value = '';
    document.getElementById('manualQrInput').focus();
}

function closeScanner() {
    document.getElementById('scannerOverlay').classList.remove('active');
}

async function manualQrSearch() {
    const code = document.getElementById('manualQrInput').value.trim();
    if (!code) return;

    const items = await getAllFromStore(STORES.ITEMS);
    const item = items.find(i => i.qrCode === code || i.sku === code);

    if (item) {
        closeScanner();
        // Navigate to brand and highlight item
        currentBrandId = item.brandId;
        const brand = await getFromStore(STORES.BRANDS, item.brandId);
        document.getElementById('currentBrandName').textContent = brand?.name || 'Produit';
        document.getElementById('brandDetailTitle').textContent = brand?.name || 'Produit';
        showScreen('brandDetail');
        await loadBrandItems();
        showToast(`✅ Trouvé: ${item.name}`);
        await logSecurityEvent('qr_scan', currentUser.email, 'success', { qrCode: code, itemId: item.id });
    } else {
        showToast('❌ Produit non trouvé');
        await logSecurityEvent('qr_scan', currentUser.email, 'fail', { qrCode: code, reason: 'not_found' });
    }
}

// ============================================
// ACTION SHEET
// ============================================

function openSheet(id) {
    currentItemId = id;
    document.getElementById('sheetOverlay').classList.add('active');
}

function closeSheet(event) {
    if (!event || event.target === document.getElementById('sheetOverlay')) {
        document.getElementById('sheetOverlay').classList.remove('active');
        currentItemId = null;
    }
}

async function editCurrentItem() {
    if (!currentItemId) return;
    const items = await getAllFromStore(STORES.ITEMS);
    const item = items.find(i => i.id === currentItemId);
    if (item) {
        closeSheet();
        setTimeout(() => openItemModal(item), 300);
    }
}

async function duplicateCurrentItem() {
    if (!currentItemId) return;
    const items = await getAllFromStore(STORES.ITEMS);
    const item = items.find(i => i.id === currentItemId);
    if (item) {
        const newItem = { ...item };
        delete newItem.id;
        newItem.name = item.name + ' (copie)';
        newItem.qrCode = generateUniqueCode();
        newItem.createdAt = Date.now();
        newItem.updatedAt = Date.now();
        newItem.userId = currentUser.id;

        await addToStore(STORES.ITEMS, newItem);
        closeSheet();
        await loadBrandItems();
        await loadBrands();
        showToast('📋 Produit dupliqué');
    }
}

async function deleteCurrentItem() {
    if (!currentItemId) return;
    if (confirm('Êtes-vous sûr de vouloir supprimer ce champagne ?')) {
        await deleteFromStore(STORES.ITEMS, currentItemId);
        await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'delete_item', itemId: currentItemId });
        closeSheet();
        await loadBrandItems();
        await loadBrands();
        showToast('🗑️ Produit supprimé');
    }
}

// ============================================
// EXPORT CSV
// ============================================

async function exportToCSV() {
    if (!currentUser) return;

    const items = await getAllFromStore(STORES.ITEMS);
    const brands = await getAllFromStore(STORES.BRANDS);

    const userItems = currentUser.role === 'admin' ? items : items.filter(i => i.userId === currentUser.id);

    let csv = 'QR Code,SKU,Nom,Maison,Gamme,Millésime,Quantité,Stock Min,Prix Public (€),Prix Export (€),Valeur Stock (€),Description\n';

    for (const item of userItems) {
        const brand = brands.find(b => b.id === item.brandId);
        const stockValue = (item.priceExport || 0) * (item.quantity || 0);
        csv += `"${item.qrCode || ''}","${item.sku || ''}","${item.name || ''}","${brand?.name || ''}","${gammeLabels[item.gamme] || ''}","${item.vintage || ''}",${item.quantity || 0},${item.minStock || 0},${item.pricePublic || 0},${item.priceExport || 0},${stockValue.toFixed(2)},"${(item.description || '').replace(/"/g, '""')}"\n`;
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `inventaire-champagne-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    showToast('📊 Export CSV réussi');
    await logSecurityEvent('admin_action', currentUser.email, 'success', { action: 'export_csv', count: userItems.length });
}

// ============================================
// ADMIN PANEL
// ============================================

async function loadAdminData() {
    if (currentUser?.role !== 'admin') return;

    const logs = await getAllFromStore(STORES.LOGS);
    logs.sort((a, b) => b.timestamp - a.timestamp);

    const tbody = document.getElementById('securityLogsBody');
    if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light);">Aucun événement</td></tr>';
    } else {
        tbody.innerHTML = logs.slice(0, 100).map(log => {
            const date = new Date(log.timestamp).toLocaleString('fr-FR');
            const statusClass = log.status === 'success' ? 'success' : 'fail';
            return `<tr><td>${date}</td><td>${log.type}</td><td>${escapeHtml(log.identifier)}</td><td>${log.ip}</td><td>${log.device} / ${log.browser}</td><td><span class="log-status ${statusClass}">${log.status}</span></td></tr>`;
        }).join('');
    }

    const users = await getAllFromStore(STORES.USERS);
    document.getElementById('usersList').innerHTML = users.map(user => {
        const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        return `<div class="user-row"><div class="user-row-info"><div class="user-row-avatar">${initials}</div><div><div class="user-row-name">${escapeHtml(user.name)} ${user.role === 'admin' ? '<span style="color:var(--gold);font-size:11px;">[ADMIN]</span>' : ''}</div><div class="user-row-email">${escapeHtml(user.email)}</div></div></div><div style="font-size:12px;color:var(--text-light);">${user.lastLogin ? new Date(user.lastLogin).toLocaleDateString('fr-FR') : 'Jamais'}</div></div>`;
    }).join('');
}

async function clearAllData() {
    if (!confirm('⚠️ ATTENTION ! Cette action supprimera TOUTES les données. Êtes-vous absolument sûr ?')) return;
    if (!confirm('Êtes-vous VRAIMENT sûr ? Irréversible.')) return;

    await logSecurityEvent('admin_action', currentUser.email, 'success', { action: 'clear_all_data' });

    for (const storeName of Object.values(STORES)) {
        const items = await getAllFromStore(storeName);
        for (const item of items) await deleteFromStore(storeName, item.id);
    }

    localStorage.clear();
    showToast('🗑️ Toutes les données effacées');
    logout();
}

// ============================================
// UTILITAIRES
// ============================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

// ============================================
// PWA
// ============================================

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(() => console.log('SW enregistré'))
        .catch(err => console.log('SW erreur:', err));
}

// ============================================
// DÉMARRAGE
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        const hasSession = await checkExistingSession();
        if (!hasSession) {
            document.getElementById('authScreen').style.display = 'flex';
        }
        console.log('🍾 Champagne Inventory initialisé');
    } catch (error) {
        console.error('Erreur init:', error);
        showToast('❌ Erreur de démarrage');
    }
});
