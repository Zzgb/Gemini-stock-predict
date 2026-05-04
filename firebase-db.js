import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  collection,
  getDocs,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD0...",
  authDomain: "zzzzk-stock-dashboard.firebaseapp.com",
  projectId: "zzzzk-stock-dashboard",
  storageBucket: "zzzzk-stock-dashboard.firebasestorage.app",
  messagingSenderId: "1027495585053",
  appId: "1:1027495585053:web:7f83107e0ac9424a45edf4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, "gupiaoyucedata");

// 监听股票文档
export function watchStock(stockId, onData, onError) {
  const docRef = doc(db, "stocks", stockId);
  return onSnapshot(
    docRef,
    (snapshot) => { if (snapshot.exists()) onData(snapshot.data()); },
    (error) => { console.error(`监听 ${stockId} 出错:`, error); if (onError) onError(error); }
  );
}

// 本地缓存键
const ALL_STOCKS_CACHE_KEY = 'all_stocks_cache_v3';
const CONFIG_TIMESTAMP_KEY = 'all_stocks_last_update';

async function fetchAllStocksRaw() {
  const stocksRef = collection(db, "all_stocks");
  const snapshot = await getDocs(stocksRef);
  const list = [];
  snapshot.forEach(doc => {
    if (doc.id !== "_config") {
      const d = doc.data();
      list.push({ symbol: d.symbol, name: d.name, region: d.region });
    }
  });
  return list;
}

async function getConfigTimestamp() {
  const configRef = doc(db, "all_stocks", "_config");
  const snap = await getDoc(configRef);
  if (snap.exists()) return snap.data().lastUpdate_time || null;
  return null;
}

/**
 * 按需获取全量股票列表（带缓存时间戳比对）
 * 仅在用户首次搜索时调用，或缓存过期时重新拉取
 */
export async function fetchAllStocksCacheOrLoad(timeoutMs = 30000) {
  const cached = localStorage.getItem(ALL_STOCKS_CACHE_KEY);
  const cachedTimestamp = localStorage.getItem(CONFIG_TIMESTAMP_KEY);

  // 先尝试通过时间戳判断是否需要更新
  try {
    const remoteTs = await Promise.race([
      getConfigTimestamp(),
      new Promise(resolve => setTimeout(() => resolve(null), 8000))
    ]);
    if (remoteTs && cached && cachedTimestamp === remoteTs) {
      console.log("📦 本地缓存与云端同步，直接使用");
      return { list: JSON.parse(cached), error: null };
    }
  } catch (e) {
    if (cached) {
      console.warn("检查更新时间失败，使用过期缓存");
      return { list: JSON.parse(cached), error: null };
    }
  }

  // 需要拉取全量
  console.log("☁️ 从 Firestore 拉取全量股票");
  let timer;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });

  try {
    const result = await Promise.race([fetchAllStocksRaw(), timeoutPromise]);
    clearTimeout(timer);
    if (result && !result.timeout && Array.isArray(result)) {
      const list = result;
      localStorage.setItem(ALL_STOCKS_CACHE_KEY, JSON.stringify(list));
      const ts = await getConfigTimestamp().catch(() => null);
      if (ts) localStorage.setItem(CONFIG_TIMESTAMP_KEY, ts);
      return { list, error: null };
    } else {
      // 超时但可能有旧缓存
      if (cached) {
        return { list: JSON.parse(cached), error: 'timeout' };
      }
      return { list: [], error: 'timeout' };
    }
  } catch (err) {
    clearTimeout(timer);
    if (cached) {
      return { list: JSON.parse(cached), error: err };
    }
    return { list: [], error: err };
  }
}

export { app, db };