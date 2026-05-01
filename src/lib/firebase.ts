import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from '../config/env.js';

let _db: Firestore | null = null;

export function initFirebase(): Firestore {
  if (!getApps().length) {
    const app: App = initializeApp({
      credential: cert({
        projectId:   env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey:  env.FIREBASE_PRIVATE_KEY,
      }),
    });
    _db = getFirestore(app);
  } else {
    _db = getFirestore();
  }

  // Aktifkan ignore undefined agar tidak error saat field undefined
  _db.settings({ ignoreUndefinedProperties: true });

  return _db;
}

export function getDb(): Firestore {
  if (!_db) {
    throw new Error('[firebase] Firestore belum diinisialisasi. Panggil initFirebase() terlebih dahulu.');
  }
  return _db;
}
