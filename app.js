// ============================================
// INVENTAIRE PRO - PWA avec IndexedDB
// ============================================

const DB_NAME = 'InventaireProDB';
const DB_VERSION = 1;
const STORE_NAME = 'items';

let db = null;
let currentFilter = 'all';
let currentSearch = '';
let currentItemId = null;
let deferredPrompt = null;

// Emojis par catégorie
const categoryEmojis = {
    electronique: '💻',
    alimentaire: '🍎',
    textile: '👕',
    outillage: '🔧',
    autre: '📦'
};

const categoryLabels = {
    electronique: 'Électronique',
    alimentaire: 'Alimentaire',
    textile: 'Textile',
    outillage: 'Outillage',
    autre: 'Autre'
};

// ============================================
// INITIALISATION
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
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('category', 'category', { unique: false });
                store.createIndex('sku', 'sku', { unique: false });
            }
        };
    });
}

async function init() {
    try {
        await initDB();
        await loadItems();
        showToast('📦 Inventaire Pro prêt !');
    } catch (error) {
        console.error('Erreur DB:', error);
        showToast('❌ Erreur de base de données');
    }
}

// ============================================
// CRUD OPERATIONS
// ============================================

function getAllItems() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function addItem(item) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(item);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function updateItem(item) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(item);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function deleteItem(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============================================
// UI - AFFICHAGE
// ============================================

async function loadItems() {
    const items = await getAllItems();
    renderItems(items);
    updateStats(items);
}

function renderItems(items) {
    const container = document.getElementById('itemsContainer');
    const emptyState = document.getElementById('emptyState');

    // Filtrage
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

    // Tri par date de modification (plus récent en premier)
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">📭</div>
                <h3>${items.length === 0 ? 'Aucun article' : 'Aucun résultat'}</h3>
                <p>${items.length === 0 ? 'Commencez par ajouter votre premier article' : 'Essayez une autre recherche'}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const stockPercent = item.minStock > 0 
            ? Math.min((item.quantity / item.minStock) * 100, 100) 
            : 100;

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
                        <div class="stock-bar">
                            <div class="stock-fill ${stockClass}" style="width: ${stockPercent}%"></div>
                        </div>
                        <span class="stock-text">${item.quantity}</span>
                    </div>
                    <div class="item-price">${(item.price * item.quantity).toFixed(2)}€ <small style="color: var(--text-light); font-weight: 400;">(${item.price.toFixed(2)}€/u)</small></div>
                </div>
            </div>
        `;
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

// ============================================
// FILTRES & RECHERCHE
// ============================================

function filterItems() {
    currentSearch = document.getElementById('searchInput').value;
    loadItems();
}

function toggleFilters() {
    const panel = document.getElementById('filterPanel');
    const btn = document.getElementById('filterBtn');
    panel.classList.toggle('open');
    btn.classList.toggle('active');
}

function setCategory(category) {
    currentFilter = category;

    // Update chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.classList.remove('active');
    });
    event.target.classList.add('active');

    loadItems();
}

// ============================================
// MODAL - AJOUT/MODIFICATION
// ============================================

function openModal(item = null) {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const form = document.getElementById('itemForm');

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
        form.reset();
        document.getElementById('itemId').value = '';
    }

    overlay.classList.add('active');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}

async function saveItem(event) {
    event.preventDefault();

    const id = document.getElementById('itemId').value;
    const item = {
        name: document.getElementById('itemName').value.trim(),
        category: document.getElementById('itemCategory').value,
        quantity: parseInt(document.getElementById('itemQuantity').value) || 0,
        minStock: parseInt(document.getElementById('itemMinStock').value) || 0,
        price: parseFloat(document.getElementById('itemPrice').value) || 0,
        sku: document.getElementById('itemSku').value.trim(),
        description: document.getElementById('itemDescription').value.trim(),
        updatedAt: Date.now()
    };

    try {
        if (id) {
            item.id = parseInt(id);
            await updateItem(item);
            showToast('✅ Article modifié');
        } else {
            item.createdAt = Date.now();
            await addItem(item);
            showToast('✅ Article ajouté');
        }

        closeModal();
        await loadItems();
    } catch (error) {
        console.error(error);
        showToast('❌ Erreur lors de la sauvegarde');
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

    const items = await getAllItems();
    const item = items.find(i => i.id === currentItemId);

    if (item) {
        closeSheet();
        setTimeout(() => openModal(item), 300);
    }
}

async function duplicateCurrentItem() {
    if (!currentItemId) return;

    const items = await getAllItems();
    const item = items.find(i => i.id === currentItemId);

    if (item) {
        const newItem = { ...item };
        delete newItem.id;
        newItem.name = item.name + ' (copie)';
        newItem.createdAt = Date.now();
        newItem.updatedAt = Date.now();

        await addItem(newItem);
        closeSheet();
        await loadItems();
        showToast('📋 Article dupliqué');
    }
}

async function deleteCurrentItem() {
    if (!currentItemId) return;

    if (confirm('Êtes-vous sûr de vouloir supprimer cet article ?')) {
        await deleteItem(currentItemId);
        closeSheet();
        await loadItems();
        showToast('🗑️ Article supprimé');
    }
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

    setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

// ============================================
// INSTALLATION PWA
// ============================================

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    // Afficher la bannière après 2 secondes
    setTimeout(() => {
        document.getElementById('installBanner').classList.add('show');
    }, 2000);
});

function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                showToast('✅ Application installée !');
            }
            document.getElementById('installBanner').classList.remove('show');
            deferredPrompt = null;
        });
    }
}

// ============================================
// SERVICE WORKER
// ============================================

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW enregistré'))
        .catch(err => console.log('SW erreur:', err));
}

// ============================================
// DÉMARRAGE
// ============================================

document.addEventListener('DOMContentLoaded', init);
