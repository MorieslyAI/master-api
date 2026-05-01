import { v4 as uuidv4 } from 'uuid';
import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getDb } from '../lib/firebase.js';
import { signSocketToken, type SocketScope } from '../lib/jwt.js';
import { env } from '../config/env.js';

// ─── Firestore Collections ────────────────────────────────────────────────────
const COL_USERS = 'users';

// ─── Firebase Auth REST API ───────────────────────────────────────────────────
const FIREBASE_AUTH_URL    = 'https://identitytoolkit.googleapis.com/v1/accounts';
const FIREBASE_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';

// ─── Firestore Document Types ─────────────────────────────────────────────────

interface UserDoc {
  email:                 string;
  displayName:           string;
  role:                  'user' | 'admin';
  provider:              'email' | 'google';
  isCalibrationComplete: boolean;
  createdAt:             FirebaseFirestore.FieldValue;
  updatedAt:             FirebaseFirestore.FieldValue;
  photoURL?:             string;
}

// ─── Firebase REST API Response Types ────────────────────────────────────────

interface FirebaseAuthResponse {
  localId:      string;
  email:        string;
  idToken:      string;
  refreshToken: string;
  expiresIn:    string;  // detik sebagai string, e.g. "3600"
}

interface FirebaseRefreshResponse {
  id_token:      string;
  refresh_token: string;
  expires_in:    string;
  user_id:       string;
}

interface FirebaseErrorBody {
  error?: { message?: string };
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface RegisterDTO {
  email:        string;
  password:     string;
  displayName?: string;
}

export interface LoginDTO {
  email:    string;
  password: string;
}

export interface GoogleSignInDTO {
  idToken:      string;  // Firebase ID Token dari Google Sign-In (FE → Firebase Client SDK)
  refreshToken: string;  // Firebase Refresh Token dari FE
}

export interface AuthResult {
  accessToken:  string;   // Firebase ID Token (berlaku 1 jam)
  refreshToken: string;   // Firebase Refresh Token (long-lived, disimpan di httpOnly cookie)
  expiresIn:    number;   // detik sampai accessToken kadaluarsa (3600)
  isNewUser?:   boolean;  // true jika user baru pertama kali login via Google
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── Firebase Error Mapper ────────────────────────────────────────────────────

function mapFirebaseError(code?: string): { message: string; status: number } {
  switch (code) {
    case 'EMAIL_EXISTS':
      return { message: 'Email is already registered.', status: 409 };
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_EMAIL':
      return { message: 'Incorrect email or password.', status: 401 };
    case 'USER_DISABLED':
      return { message: 'This account has been disabled.', status: 403 };
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return { message: 'Too many login attempts. Please try again later.', status: 429 };
    case 'WEAK_PASSWORD : Password should be at least 6 characters':
    case 'WEAK_PASSWORD':
      return { message: 'Password is too weak. Minimum 6 characters required.', status: 400 };
    default:
      return { message: 'Authentication failed.', status: 500 };
  }
}

// ─── Firebase Auth REST Caller ────────────────────────────────────────────────

async function callFirebaseSignUp(email: string, password: string): Promise<FirebaseAuthResponse> {
  const res = await fetch(`${FIREBASE_AUTH_URL}:signUp?key=${env.FIREBASE_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = await res.json() as FirebaseAuthResponse | FirebaseErrorBody;

  if (!res.ok) {
    const { message, status } = mapFirebaseError((data as FirebaseErrorBody).error?.message);
    throw httpError(message, status);
  }

  return data as FirebaseAuthResponse;
}

async function callFirebaseSignIn(email: string, password: string): Promise<FirebaseAuthResponse> {
  const res = await fetch(`${FIREBASE_AUTH_URL}:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = await res.json() as FirebaseAuthResponse | FirebaseErrorBody;

  if (!res.ok) {
    const { message, status } = mapFirebaseError((data as FirebaseErrorBody).error?.message);
    throw httpError(message, status);
  }

  return data as FirebaseAuthResponse;
}

async function callFirebaseRefresh(refreshToken: string): Promise<FirebaseRefreshResponse> {
  const res = await fetch(`${FIREBASE_REFRESH_URL}?key=${env.FIREBASE_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  const data = await res.json() as FirebaseRefreshResponse | FirebaseErrorBody;

  if (!res.ok) {
    throw httpError('Refresh token is invalid or has expired.', 401);
  }

  return data as FirebaseRefreshResponse;
}

// ─── Auth Service ─────────────────────────────────────────────────────────────

export const authService = {

  async register(dto: RegisterDTO): Promise<AuthResult> {
    const email = dto.email.toLowerCase().trim();

    // 1. Buat user di Firebase Authentication
    const firebaseRes = await callFirebaseSignUp(email, dto.password);
    const uid         = firebaseRes.localId;
    const now         = FieldValue.serverTimestamp();

    // 2. Set custom claims (role) agar tersedia di ID token
    await getAuth().setCustomUserClaims(uid, { role: 'user' });

    // 3. Update displayName di Firebase Auth (jika ada)
    if (dto.displayName) {
      await getAuth().updateUser(uid, { displayName: dto.displayName });
    }

    // 4. Buat dokumen profil di Firestore untuk data tambahan
    await getDb().collection(COL_USERS).doc(uid).set({
      email,
      displayName:           dto.displayName ?? '',
      role:                  'user',
      provider:              'email',
      isCalibrationComplete: false,
      createdAt:             now,
      updatedAt:             now,
    } satisfies UserDoc);

    return {
      accessToken:  firebaseRes.idToken,
      refreshToken: firebaseRes.refreshToken,
      expiresIn:    parseInt(firebaseRes.expiresIn, 10),
    };
  },

  async login(dto: LoginDTO): Promise<AuthResult> {
    const email = dto.email.toLowerCase().trim();

    const firebaseRes = await callFirebaseSignIn(email, dto.password);

    return {
      accessToken:  firebaseRes.idToken,
      refreshToken: firebaseRes.refreshToken,
      expiresIn:    parseInt(firebaseRes.expiresIn, 10),
    };
  },

  // Google Sign-In: FE performs Google OAuth via Firebase Client SDK,
  // then sends idToken + refreshToken to BE for verification and profile creation.
  async googleSignIn(dto: GoogleSignInDTO): Promise<AuthResult> {
    // 1. Verify ID Token from Firebase (ensure token is valid and belongs to this project)
    const decoded = await getAuth().verifyIdToken(dto.idToken).catch(() => {
      throw httpError('Invalid Google token.', 401);
    });

    const uid         = decoded.uid;
    const email       = decoded.email       ?? '';
    const displayName = decoded.name        ?? decoded.email?.split('@')[0] ?? '';
    const photoURL    = decoded.picture     ?? undefined;

    const db      = getDb();
    const userRef = db.collection(COL_USERS).doc(uid);
    const userDoc = await userRef.get();
    const isNewUser = !userDoc.exists;

    if (isNewUser) {
      // User baru — buat dokumen Firestore dan set custom claims
      const now = FieldValue.serverTimestamp();

      await userRef.set({
        email,
        displayName,
        role:                  'user',
        provider:              'google',
        photoURL:              photoURL ?? null,
        isCalibrationComplete: false,
        createdAt:             now,
        updatedAt:             now,
      });

      // Set custom claim role agar tersedia di token berikutnya
      await getAuth().setCustomUserClaims(uid, { role: 'user' });
    }

    return {
      accessToken:  dto.idToken,
      refreshToken: dto.refreshToken,
      expiresIn:    3600,
      isNewUser,
    };
  },

  async refresh(refreshToken: string): Promise<AuthResult> {
    const firebaseRes = await callFirebaseRefresh(refreshToken);

    return {
      accessToken:  firebaseRes.id_token,
      refreshToken: firebaseRes.refresh_token,
      expiresIn:    parseInt(firebaseRes.expires_in, 10),
    };
  },

  // Revoke semua refresh token user di Firebase Auth
  async logout(uid: string): Promise<void> {
    await getAuth().revokeRefreshTokens(uid);
  },

  async issueSocketToken(
    userId: string,
    _email: string,
    _role:  string,
    scope:  SocketScope = 'all'
  ): Promise<string> {
    const jti = uuidv4();
    return signSocketToken(userId, jti, scope);
  },

  async getProfile(userId: string) {
    const doc = await getDb().collection(COL_USERS).doc(userId).get();
    if (!doc.exists) throw httpError('User not found.', 404);

    const data = doc.data() as UserDoc;
    return {
      userId:                doc.id,
      email:                 data.email,
      displayName:           data.displayName,
      role:                  data.role,
      isCalibrationComplete: data.isCalibrationComplete ?? false,
      createdAt:             (data as any).createdAt?.toDate().toISOString(),
    };
  },
};
