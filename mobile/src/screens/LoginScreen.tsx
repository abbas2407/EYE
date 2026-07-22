import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, StatusBar
} from 'react-native';
import FieldPulseLogo from '../components/FieldPulseLogo';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import { API_BASE_URL, saveTokens } from '../api/client';

interface LoginScreenProps {
  onLoginSuccess: (role: string) => void;
}

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function getDeviceUUID(): Promise<string> {
    try {
      if (Platform.OS === 'android') {
        return Application.getAndroidId() ?? 'unknown-android';
      } else {
        return (await Application.getIosIdForVendorAsync()) ?? 'unknown-ios';
      }
    } catch {
      return 'unknown-device';
    }
  }

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      setError('Please enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const device_uuid = await getDeviceUUID();
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, device_uuid }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.detail ?? 'Invalid credentials. Please try again.');
        return;
      }

      const data = await response.json();
      await saveTokens(data.access_token, data.refresh_token, data.role, data.name);
      onLoginSuccess(data.role);
    } catch (err) {
      setError('Unable to connect to server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }}>
      <StatusBar barStyle="dark-content" backgroundColor="#faf9f6" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo area */}
          <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 32, paddingTop: 64 }}>
            <View style={{ marginBottom: 48, alignItems: 'flex-start' }}>
              <FieldPulseLogo size={100} variant="light" showTagline={true} />
            </View>

            {/* Email field */}
            <View style={{ marginBottom: 24 }}>
              <Text style={{
                fontSize: 9,
                color: '#695d4a',
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                fontFamily: 'DM-Sans',
                marginBottom: 8,
              }}>
                Email Address
              </Text>
              <TextInput
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: '#c4c7c7',
                  paddingVertical: 10,
                  fontSize: 15,
                  color: '#1a1c1a',
                  fontFamily: 'DM-Sans',
                }}
                placeholder="your@email.com"
                placeholderTextColor="#c4c7c7"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            {/* Password field */}
            <View style={{ marginBottom: 32 }}>
              <Text style={{
                fontSize: 9,
                color: '#695d4a',
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                fontFamily: 'DM-Sans',
                marginBottom: 8,
              }}>
                Password
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#c4c7c7' }}>
                <TextInput
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    fontSize: 15,
                    color: '#1a1c1a',
                    fontFamily: 'DM-Sans',
                  }}
                  placeholder="••••••••"
                  placeholderTextColor="#c4c7c7"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={{ padding: 4 }}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color="#747878"
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Error message */}
            {error && (
              <View style={{
                backgroundColor: '#fee2e2',
                borderRadius: 4,
                padding: 12,
                marginBottom: 20,
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
              }}>
                <Ionicons name="alert-circle-outline" size={16} color="#991b1b" style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, fontSize: 12, color: '#991b1b', fontFamily: 'DM-Sans', lineHeight: 18 }}>
                  {error}
                </Text>
              </View>
            )}

            {/* Sign In button */}
            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              style={{
                backgroundColor: loading ? '#444748' : '#1a1c1a',
                paddingVertical: 16,
                borderRadius: 4,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 8,
              }}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Text style={{
                    color: '#ffffff',
                    fontSize: 12,
                    fontFamily: 'DM-Sans',
                    fontWeight: '500',
                    textTransform: 'uppercase',
                    letterSpacing: 1.5,
                  }}>
                    Sign In
                  </Text>
                  <Ionicons name="arrow-forward" size={14} color="#ffffff" />
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Footer */}
          <View style={{ paddingHorizontal: 32, paddingBottom: 32, alignItems: 'center' }}>
            <Text style={{ fontSize: 11, color: '#c4c7c7', fontFamily: 'DM-Sans' }}>
              FieldPulse v1.0 · Field Operations
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
