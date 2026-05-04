import { getFirestore, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js";
import { app } from './firebase-db.js';

const db = getFirestore(app, "gupiaoyucedata");

// 原有：添加自选股到 list
export async function addStockToList(symbol, region, chineseName) {
    const listRef = doc(db, "settings", "list");
    await setDoc(listRef, {
        [chineseName]: [symbol, region, chineseName],
        update_time: new Date(),
        create_by: "Web"
    }, { merge: true });
}

// 新增：更新最近访问时间
export async function updateLastAccessed(symbol) {
    const stockRef = doc(db, "stocks", symbol);
    await updateDoc(stockRef, { lastAccessed: new Date() }).catch(err => {
        console.warn(`更新 lastAccessed 失败 (${symbol}):`, err);
    });
}