// ============================================
// INVENTAIRE PRO - SÉCURISÉ
// Auth, Admin, Security Logs, IndexedDB
// ============================================

const DB_NAME = 'InventaireProSecureDB';
const DB_VERSION = 1;
const STORES = {
    USERS: 'users',
    ITEMS: 'items',
    LOGS: 'securityLogs',
    SESSIONS: 'sessions'
};

// === CONFIGURATION ===
const ADMIN_CODE = 'ADMIN2024!';  // Code secret pour devenir admin
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

// === ÉTAT GLOBAL ===
let db = null;
let currentUser = null;
let currentSession = null;
let currentFilter = 'all';
let currentSearch = '';
let currentItemId = null;
let enteredPin = '';
let deferredPrompt = null;

// === CATÉGORIES ===
const categoryEmojis = {
    electronique: '💻', alimentaire: '🍎', textile: '👕',
    outillage: '🔧', autre: '📦'
};
const categoryLabels = {
    electronique: 'Électronique', alimentaire: 'Alimentaire',
    textile: 'Textile', outillage: 'Outillage', autre: 'Autre'
};

// ============================================
// INITIALISATION DB
// ============================================

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // Store Utilisateurs
            if (!database.objectStoreNames.contains(STORES.USERS)) {
                const usersStore = database.createObjectStore(STORES.USERS, { keyPath: 'id', autoIncrement: true });
                usersStore.createIndex('email', 'email', { unique: true });
                usersStore.createIndex('role', 'role', { unique: false });
            }

            // Store Articles
            if (!database.objectStoreNames.contains(STORES.ITEMS)) {
                const itemsStore = database.createObjectStore(STORES.ITEMS, { keyPath: 'id', autoIncrement: true });
                itemsStore.createIndex('name', 'name', { unique: false });
                itemsStore.createIndex('category', 'category', { unique: false });
                itemsStore.createIndex('userId', 'userId', { unique: false });
            }

            // Store Logs de sécurité
            if (!database.objectStoreNames.contains(STORES.LOGS)) {
                const logsStore = database.createObjectStore(STORES.LOGS, { keyPath: 'id', autoIncrement: true });
                logsStore.createIndex('timestamp', 'timestamp', { unique: false });
                logsStore.createIndex('type', 'type', { unique: false });
                logsStore.createIndex('ip', 'ip', { unique: false });
            }

            // Store Sessions
            if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
                const sessionsStore = database.createObjectStore(STORES.SESSIONS, { keyPath: 'id', autoIncrement: true });
                sessionsStore.createIndex('userId', 'userId', { unique: false });
                sessionsStore.createIndex('token', 'token', { unique: true });
            }
        };
    });
}

// ============================================
// UTILITAIRES CRYPTO & SÉCURITÉ
// ============================================

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

function encryptData(data, key) {
    // Simple XOR obfuscation (pas vrai chiffrement, mais dissuasion basique)
    // Pour une vraie sécurité, il faudrait un backend
    const encoded = btoa(JSON.stringify(data));
    let encrypted = '';
    for (let i = 0; i < encoded.length; i++) {
        encrypted += String.fromCharCode(encoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return btoa(encrypted);
}

function decryptData(encrypted, key) {
    try {
        const decoded = atob(encrypted);
        let decrypted = '';
        for (let i = 0; i < decoded.length; i++) {
            decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return JSON.parse(atob(decrypted));
    } catch {
        return null;
    }
}

// ============================================
// RÉCUPÉRATION INFOS SYSTÈME
// ============================================

function getDeviceInfo() {
    const ua = navigator.userAgent;
    let device = 'Inconnu';
    let os = 'Inconnu';

    if (/Android/.test(ua)) {
        device = 'Android';
        os = ua.match(/Android\s([\d.]+)/)?.[1] || 'Android';
    } else if (/iPhone|iPad|iPod/.test(ua)) {
        device = 'iOS';
        os = ua.match(/OS\s([\d_]+)/)?.[1]?.replace(/_/g, '.') || 'iOS';
    } else if (/Windows/.test(ua)) {
        device = 'Windows';
        os = ua.match(/Windows\sNT\s([\d.]+)/)?.[1] || 'Windows';
    } else if (/Mac/.test(ua)) {
        device = 'Mac';
        os = 'macOS';
    } else if (/Linux/.test(ua)) {
        device = 'Linux';
        os = 'Linux';
    }

    const browser = /Chrome/.test(ua) ? 'Chrome' :
                    /Firefox/.test(ua) ? 'Firefox' :
                    /Safari/.test(ua) ? 'Safari' :
                    /Edge/.test(ua) ? 'Edge' : 'Navigateur inconnu';

    return { device, os, browser, userAgent: ua, screen: `${screen.width}x${screen.height}`, language: navigator.language };
}

async function getIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        const data = await response.json();
        return data.ip;
    } catch {
        return '127.0.0.1 (local)';
    }
}

// ============================================
// LOGS DE SÉCURITÉ
// ============================================

async function logSecurityEvent(type, identifier, status, details = {}) {
    const deviceInfo = getDeviceInfo();
    const ip = await getIP();

    const log = {
        timestamp: Date.now(),
        type: type,           // 'login_attempt', 'register', 'logout', 'lockout', 'data_access', 'admin_action'
        identifier: identifier, // email ou username utilisé
        status: status,       // 'success', 'fail', 'blocked'
        ip: ip,
        device: deviceInfo.device,
        os: deviceInfo.os,
        browser: deviceInfo.browser,
        screen: deviceInfo.screen,
        language: deviceInfo.language,
        userAgent: deviceInfo.userAgent.substring(0, 200),
        details: details,
        userId: currentUser?.id || null
    };

    await addToStore(STORES.LOGS, log);
    console.log('🔒 Security Log:', log);
}

// ============================================
// OPÉRATIONS DB GÉNÉRIQUES
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
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');

    if (tab === 'login') {
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('registerForm').style.display = 'none';
    } else {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('registerForm').style.display = 'block';
    }
    hideAuthError();
}

function showAuthError(message) {
    const errorDiv = document.getElementById('authError');
    document.getElementById('authErrorText').textContent = message;
    errorDiv.classList.add('show');
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

async function handleRegister(event) {
    event.preventDefault();
    hideAuthError();

    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const password = document.getElementById('regPassword').value;
    const passwordConfirm = document.getElementById('regPasswordConfirm').value;
    const adminCode = document.getElementById('regAdminCode').value;

    // Validation
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

    // Vérifier si email existe déjà
    const existingUser = await getByIndex(STORES.USERS, 'email', email);
    if (existingUser) {
        showAuthError('Un compte existe déjà avec cet email');
        await logSecurityEvent('register', email, 'fail', { reason: 'email_exists' });
        return;
    }

    // Déterminer le rôle
    const role = (adminCode === ADMIN_CODE) ? 'admin' : 'user';

    // Hasher le mot de passe
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    // Créer l'utilisateur
    const user = {
        name,
        email,
        passwordHash,
        salt,
        role,
        createdAt: Date.now(),
        lastLogin: null,
        loginAttempts: 0,
        lockedUntil: null,
        pin: null // Sera défini après première connexion
    };

    const userId = await addToStore(STORES.USERS, user);

    await logSecurityEvent('register', email, 'success', { userId, role });

    showToast('✅ Compte créé ! Connectez-vous');
    switchTab('login');
    document.getElementById('loginEmail').value = email;
}

async function handleLogin(event) {
    event.preventDefault();
    hideAuthError();

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    // Vérifier si l'utilisateur existe
    const user = await getByIndex(STORES.USERS, 'email', email);

    if (!user) {
        showAuthError('Email ou mot de passe incorrect');
        await logSecurityEvent('login_attempt', email, 'fail', { reason: 'user_not_found' });
        return;
    }

    // Vérifier si le compte est verrouillé
    if (user.lockedUntil && Date.now() < user.lockedUntil) {
        const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
        showAuthError(`Compte verrouillé. Réessayez dans ${remaining} minutes`);
        await logSecurityEvent('login_attempt', email, 'blocked', { reason: 'account_locked', remaining_minutes: remaining });
        return;
    }

    // Vérifier le mot de passe
    const passwordHash = await hashPassword(password, user.salt);

    if (passwordHash !== user.passwordHash) {
        // Incrémenter les tentatives
        user.loginAttempts = (user.loginAttempts || 0) + 1;

        if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
            user.lockedUntil = Date.now() + LOCKOUT_DURATION;
            showAuthError(`Trop de tentatives. Compte verrouillé 15 minutes`);
            await logSecurityEvent('login_attempt', email, 'blocked', { reason: 'max_attempts_reached', attempts: user.loginAttempts });
        } else {
            showAuthError(`Email ou mot de passe incorrect (${MAX_LOGIN_ATTEMPTS - user.loginAttempts} essais restants)`);
            await logSecurityEvent('login_attempt', email, 'fail', { reason: 'wrong_password', attempts: user.loginAttempts });
        }

        await updateInStore(STORES.USERS, user);
        return;
    }

    // Réinitialiser les tentatives
    user.loginAttempts = 0;
    user.lockedUntil = null;
    user.lastLogin = Date.now();
    await updateInStore(STORES.USERS, user);

    // Créer la session
    const token = generateToken();
    const session = {
        userId: user.id,
        token,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        device: getDeviceInfo()
    };

    await addToStore(STORES.SESSIONS, session);

    // Stocker le token localement (chiffré)
    const encryptedToken = encryptData({ token, userId: user.id }, user.salt);
    localStorage.setItem('sessionToken', encryptedToken);

    await logSecurityEvent('login_attempt', email, 'success', { userId: user.id, role: user.role });

    // Si pas de PIN défini, demander d'en créer un
    if (!user.pin) {
        currentUser = user;
        showSetPinScreen();
    } else {
        startSession(user);
    }
}

async function checkExistingSession() {
    const encryptedToken = localStorage.getItem('sessionToken');
    if (!encryptedToken) return false;

    // On ne peut pas déchiffrer sans le salt, donc on vérifie juste l'existence
    // En production, il faudrait un backend pour vérifier la session

    // Pour cette version locale, on demande le PIN si un token existe
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

    return false;
}

// ============================================
// PIN & VERROUILLAGE
// ============================================

function showSetPinScreen() {
    // Réutiliser l'écran de lock pour définir le PIN
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appScreen').classList.remove('active');

    document.querySelector('.lock-title').textContent = 'Définir un code PIN';
    document.querySelector('.lock-subtitle').textContent = '4 chiffres pour verrouiller votre session';
    enteredPin = '';
    updatePinDots();
}

function showLockScreen() {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');

    document.getElementById('lockUserName').textContent = currentUser?.name || 'Utilisateur';
    document.querySelector('.lock-title').textContent = 'Session verrouillée';
    document.querySelector('.lock-subtitle').textContent = 'Entrez votre code PIN';

    enteredPin = '';
    updatePinDots();
}

function enterPin(digit) {
    if (enteredPin.length < 4) {
        enteredPin += digit;
        updatePinDots();

        if (enteredPin.length === 4) {
            setTimeout(() => validatePin(), 200);
        }
    }
}

function clearPin() {
    enteredPin = enteredPin.slice(0, -1);
    updatePinDots();
}

function updatePinDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
        dot.classList.toggle('filled', i < enteredPin.length);
    });
}

async function validatePin() {
    if (!currentUser) return;

    // Si pas de PIN défini, on le crée
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

    // Vérifier le PIN
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
// GESTION SESSION
// ============================================

function startSession(user) {
    currentUser = user;
    currentSession = { startTime: Date.now() };

    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appScreen').classList.add('active');

    // Mettre à jour l'UI
    document.getElementById('headerUserName').textContent = user.name;
    document.getElementById('menuUserName').textContent = user.name;
    document.getElementById('menuUserRole').textContent = user.role === 'admin' ? 'Administrateur' : 'Utilisateur';

    if (user.role === 'admin') {
        document.getElementById('headerAdminBadge').style.display = 'inline';
        document.getElementById('menuAdminItem').style.display = 'flex';
    } else {
        document.getElementById('headerAdminBadge').style.display = 'none';
        document.getElementById('menuAdminItem').style.display = 'none';
    }

    loadItems();

    // Session timeout
    setInterval(() => {
        if (currentSession && Date.now() - currentSession.startTime > SESSION_TIMEOUT) {
            showToast('⏱️ Session expirée');
            lockSession();
        }
    }, 60000);
}

async function logout() {
    if (currentUser) {
        await logSecurityEvent('logout', currentUser.email, 'success', {});
    }

    currentUser = null;
    currentSession = null;
    localStorage.removeItem('sessionToken');

    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('appScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');
    document.getElementById('authScreen').style.display = 'flex';

    // Reset forms
    document.getElementById('loginForm').reset();
    document.getElementById('registerForm').reset();

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
    toggleMenu();

    document.getElementById('appScreen').classList.remove('active');
    document.getElementById('adminScreen').classList.remove('active');

    if (screen === 'app') {
        document.getElementById('appScreen').classList.add('active');
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
// INVENTAIRE (CRUD)
// ============================================

async function loadItems() {
    if (!currentUser) return;

    const items = await getAllFromStore(STORES.ITEMS);
    // Filtrer par utilisateur (sauf admin qui voit tout)
    const userItems = currentUser.role === 'admin' 
        ? items 
        : items.filter(item => item.userId === currentUser.id);

    renderItems(userItems);
    updateStats(userItems);
}

function renderItems(items) {
    const container = document.getElementById('itemsContainer');

    let filtered = items;
    if (currentFilter !== 'all') {
        filtered = filtered.filter(item => item.category === currentFilter);
    }
    if (currentSearch) {
        const search = currentSearch.toLowerCase();
        filtered = filtered.filter(item => 
            item.name.toLowerCase().includes(search) ||
            (item.sku && item.sku.toLowerCase().includes(search)) ||
            (item.description && item.description.toLowerCase().includes(search))
        );
    }
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">📭</div>
                <h3>${items.length === 0 ? 'Aucun article' : 'Aucun résultat'}</h3>
                <p>${items.length === 0 ? 'Commencez par ajouter votre premier article' : 'Essayez une autre recherche'}</p>
            </div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const stockPercent = item.minStock > 0 
            ? Math.min((item.quantity / item.minStock) * 100, 100) : 100;
        let stockClass = 'high';
        if (stockPercent < 30) stockClass = 'low';
        else if (stockPercent < 70) stockClass = 'medium';
        const isLow = item.quantity <= (item.minStock || 0);

        return `
            <div class="item-card" onclick="openSheet(${item.id})">
                <div class="item-image">${categoryEmojis[item.category] || '📦'}</div>
                <div class="item-info">
                    <div class="item-name">${escapeHtml(item.name)} ${isLow ? '⚠️' : ''}</div>
                    <div class="item-meta">
                        <span class="item-category">${categoryLabels[item.category] || 'Autre'}</span>
                        ${item.sku ? `<span class="item-sku">${escapeHtml(item.sku)}</span>` : ''}
                    </div>
                    <div class="item-stock">
                        <div class="stock-bar"><div class="stock-fill ${stockClass}" style="width:${stockPercent}%"></div></div>
                        <span class="stock-text">${item.quantity}</span>
                    </div>
                    <div class="item-price">${(item.price * item.quantity).toFixed(2)}€ <small style="color:var(--text-light);font-weight:400;">(${item.price.toFixed(2)}€/u)</small></div>
                </div>
            </div>`;
    }).join('');
}

function updateStats(items) {
    const totalItems = items.length;
    const totalValue = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const lowStock = items.filter(item => item.quantity <= (item.minStock || 0)).length;

    document.getElementById('totalItems').textContent = totalItems;
    document.getElementById('totalValue').textContent = totalValue.toFixed(0) + '€';
    document.getElementById('lowStockCount').textContent = lowStock;
    document.getElementById('lowStockCount').style.color = lowStock > 0 ? '#ffeb3b' : 'white';
}

function filterItems() {
    currentSearch = document.getElementById('searchInput').value;
    loadItems();
}

function toggleFilters() {
    document.getElementById('filterPanel').classList.toggle('open');
    document.getElementById('filterBtn').classList.toggle('active');
}

function setCategory(category) {
    currentFilter = category;
    document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.remove('active'));
    event.target.classList.add('active');
    loadItems();
}

// Modal
function openModal(item = null) {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');

    if (item) {
        title.textContent = 'Modifier Article';
        document.getElementById('itemId').value = item.id;
        document.getElementById('itemName').value = item.name;
        document.getElementById('itemCategory').value = item.category;
        document.getElementById('itemQuantity').value = item.quantity;
        document.getElementById('itemMinStock').value = item.minStock || '';
        document.getElementById('itemPrice').value = item.price;
        document.getElementById('itemSku').value = item.sku || '';
        document.getElementById('itemDescription').value = item.description || '';
    } else {
        title.textContent = 'Nouvel Article';
        document.getElementById('itemForm').reset();
        document.getElementById('itemId').value = '';
    }

    overlay.classList.add('active');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}

async function saveItem(event) {
    event.preventDefault();
    if (!currentUser) return;

    const id = document.getElementById('itemId').value;
    const item = {
        name: document.getElementById('itemName').value.trim(),
        category: document.getElementById('itemCategory').value,
        quantity: parseInt(document.getElementById('itemQuantity').value) || 0,
        minStock: parseInt(document.getElementById('itemMinStock').value) || 0,
        price: parseFloat(document.getElementById('itemPrice').value) || 0,
        sku: document.getElementById('itemSku').value.trim(),
        description: document.getElementById('itemDescription').value.trim(),
        userId: currentUser.id,
        updatedAt: Date.now()
    };

    try {
        if (id) {
            item.id = parseInt(id);
            await updateInStore(STORES.ITEMS, item);
            showToast('✅ Article modifié');
            await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'update_item', itemId: item.id });
        } else {
            item.createdAt = Date.now();
            const newId = await addToStore(STORES.ITEMS, item);
            showToast('✅ Article ajouté');
            await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'create_item', itemId: newId });
        }

        closeModal();
        await loadItems();
    } catch (error) {
        console.error(error);
        showToast('❌ Erreur lors de la sauvegarde');
    }
}

// Action Sheet
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
        setTimeout(() => openModal(item), 300);
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
        newItem.createdAt = Date.now();
        newItem.updatedAt = Date.now();
        newItem.userId = currentUser.id;

        await addToStore(STORES.ITEMS, newItem);
        closeSheet();
        await loadItems();
        showToast('📋 Article dupliqué');
    }
}

async function deleteCurrentItem() {
    if (!currentItemId) return;
    if (confirm('Êtes-vous sûr de vouloir supprimer cet article ?')) {
        await deleteFromStore(STORES.ITEMS, currentItemId);
        await logSecurityEvent('data_access', currentUser.email, 'success', { action: 'delete_item', itemId: currentItemId });
        closeSheet();
        await loadItems();
        showToast('🗑️ Article supprimé');
    }
}

// ============================================
// ADMIN PANEL
// ============================================

async function loadAdminData() {
    if (currentUser?.role !== 'admin') return;

    // Charger les logs
    const logs = await getAllFromStore(STORES.LOGS);
    logs.sort((a, b) => b.timestamp - a.timestamp);

    const tbody = document.getElementById('securityLogsBody');
    if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light);">Aucun événement</td></tr>';
    } else {
        tbody.innerHTML = logs.slice(0, 100).map(log => {
            const date = new Date(log.timestamp).toLocaleString('fr-FR');
            const statusClass = log.status === 'success' ? 'success' : 'fail';
            return `
                <tr>
                    <td>${date}</td>
                    <td>${log.type}</td>
                    <td>${escapeHtml(log.identifier)}</td>
                    <td>${log.ip}</td>
                    <td>${log.device} / ${log.browser}</td>
                    <td><span class="log-status ${statusClass}">${log.status}</span></td>
                </tr>
            `;
        }).join('');
    }

    // Charger les utilisateurs
    const users = await getAllFromStore(STORES.USERS);
    const usersList = document.getElementById('usersList');

    usersList.innerHTML = users.map(user => {
        const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        return `
            <div class="user-row">
                <div class="user-row-info">
                    <div class="user-row-avatar">${initials}</div>
                    <div>
                        <div class="user-row-name">${escapeHtml(user.name)} ${user.role === 'admin' ? '<span style="color:var(--warning);font-size:11px;">[ADMIN]</span>' : ''}</div>
                        <div class="user-row-email">${escapeHtml(user.email)}</div>
                    </div>
                </div>
                <div style="font-size:12px;color:var(--text-light);">
                    ${user.lastLogin ? new Date(user.lastLogin).toLocaleDateString('fr-FR') : 'Jamais connecté'}
                </div>
            </div>
        `;
    }).join('');
}

async function clearAllData() {
    if (!confirm('⚠️ ATTENTION ! Cette action supprimera TOUTES les données : utilisateurs, articles, logs. Êtes-vous absolument sûr ?')) return;
    if (!confirm('Êtes-vous VRAIMENT sûr ? Cette action est irréversible.')) return;

    await logSecurityEvent('admin_action', currentUser.email, 'success', { action: 'clear_all_data' });

    // Supprimer tout
    const stores = [STORES.ITEMS, STORES.LOGS, STORES.SESSIONS, STORES.USERS];
    for (const storeName of stores) {
        const items = await getAllFromStore(storeName);
        for (const item of items) {
            await deleteFromStore(storeName, item.id);
        }
    }

    localStorage.clear();
    showToast('🗑️ Toutes les données ont été effacées');
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
// PWA & INSTALLATION
// ============================================

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

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

        // Vérifier s'il y a une session existante
        const hasSession = await checkExistingSession();

        if (!hasSession) {
            document.getElementById('authScreen').style.display = 'flex';
        }

        console.log('🔒 Inventaire Pro Sécurisé initialisé');
    } catch (error) {
        console.error('Erreur init:', error);
        showToast('❌ Erreur de démarrage');
    }
});
