import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

export const API_BASE_URL: string = (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://167.233.90.245:8000';

const ACCESS_TOKEN_KEY = 'fp_access_token';
const REFRESH_TOKEN_KEY = 'fp_refresh_token';
const USER_ROLE_KEY = 'fp_user_role';
const USER_NAME_KEY = 'fp_user_name';

let onLogoutCallback: (() => void) | null = null;

export function registerLogoutHandler(cb: () => void) {
  onLogoutCallback = cb;
}

export async function saveTokens(access: string, refresh: string, role: string, name: string) {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, access);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refresh);
  await SecureStore.setItemAsync(USER_ROLE_KEY, role);
  await SecureStore.setItemAsync(USER_NAME_KEY, name);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function getUserRole(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_ROLE_KEY);
}

export async function getUserName(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_NAME_KEY);
}

export async function clearTokens() {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_ROLE_KEY);
  await SecureStore.deleteItemAsync(USER_NAME_KEY);
}

// Mutex: only one refresh attempt runs at a time; others wait for the result
let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const refresh = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  if (!refresh) return null;
  try {
    const r = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, data.access_token);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.refresh_token);
    return data.access_token as string;
  } catch {
    return null;
  }
}

async function getRefreshedToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers as HeadersInit || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

  if (response.status === 401) {
    const newToken = await getRefreshedToken();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
      if (response.status !== 401) return response;
    }
    await clearTokens();
    onLogoutCallback?.();
  }
  return response;
}
