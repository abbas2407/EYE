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

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers as HeadersInit || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

  if (response.status === 401) {
    const refresh = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (refresh) {
      try {
        const r = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refresh }),
        });
        if (r.ok) {
          const data = await r.json();
          await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, data.access_token);
          await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.refresh_token);
          headers.set('Authorization', `Bearer ${data.access_token}`);
          response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
          return response;
        }
      } catch {}
    }
    await clearTokens();
    onLogoutCallback?.();
  }
  return response;
}
