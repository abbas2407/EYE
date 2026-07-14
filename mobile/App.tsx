import React, { useState, useEffect, useRef, Component } from 'react';
import {
  View, Text, TouchableOpacity,
  ActivityIndicator, Platform
} from 'react-native';

// Prevents a single screen crash from blanking the entire app
class ScreenErrorBoundary extends Component<
  { children: React.ReactNode; screenName: string },
  { hasError: boolean; error: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(err: any) {
    return { hasError: true, error: String(err?.message ?? err) };
  }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#faf9f6' }}>
          <Text style={{ fontSize: 32, marginBottom: 12 }}>⚠️</Text>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c1a', textAlign: 'center', marginBottom: 8 }}>
            {this.props.screenName} failed to load
          </Text>
          <Text style={{ fontSize: 11, color: '#747878', textAlign: 'center', marginBottom: 20 }}>
            {this.state.error}
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ hasError: false, error: '' })}
            style={{ backgroundColor: '#1a1c1a', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '500' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Font from 'expo-font';
import * as Notifications from 'expo-notifications';
import NetInfo from '@react-native-community/netinfo';

import LoginScreen from './src/screens/LoginScreen';
import ScheduleScreen from './src/screens/ScheduleScreen';
import MapScreen from './src/screens/MapScreen';
import TasksScreen from './src/screens/TasksScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ChatScreen from './src/screens/ChatScreen';
import DailySummaryScreen from './src/screens/DailySummaryScreen';
import LeaveScreen from './src/screens/LeaveScreen';
import PunchModal from './src/components/PunchModal';

import {
  getAccessToken, getUserRole, clearTokens,
  registerLogoutHandler, apiFetch
} from './src/api/client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

type Tab = 'SCHEDULE' | 'MAP' | 'TASKS' | 'CHAT' | 'PROFILE';
type Screen = 'MAIN' | 'DAILY_SUMMARY' | 'LEAVE';

function MainApp() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>('SCHEDULE');
  const [screen, setScreen] = useState<Screen>('MAIN');
  const [punchModalVisible, setPunchModalVisible] = useState(false);
  const [isPunchedIn, setIsPunchedIn] = useState(false);
  const [punchInTime, setPunchInTime] = useState<string | null>(null);
  const [attendanceLogId, setAttendanceLogId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [chatUnread, setChatUnread] = useState(0);
  const lastChatVisitRef = useRef(new Date(0).toISOString());

  // Restore punch state from server on every app foreground / cold start
  useEffect(() => {
    async function syncPunchState() {
      try {
        const res = await apiFetch('/api/attendance/summary');
        if (!res?.ok) return;
        const data = await res.json();
        setIsPunchedIn(!!data.is_punched_in);
        setPunchInTime(data.punch_in_time ?? null);
        setAttendanceLogId(data.attendance_log_id ?? null);
      } catch {}
    }
    syncPunchState();
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setIsOnline(state.isConnected ?? true);
    });
    return () => unsub();
  }, []);

  // Poll for unread messages every 30 s
  useEffect(() => {
    async function pollUnread() {
      try {
        const res = await apiFetch('/api/chat/rooms');
        if (!res?.ok) return;
        const rooms: any[] = await res.json();
        const count = rooms.filter(r =>
          r.last_message_time && r.last_message_time > lastChatVisitRef.current
        ).length;
        setChatUnread(count);
      } catch {}
    }
    pollUnread();
    const t = setInterval(pollUnread, 30000);
    return () => clearInterval(t);
  }, []);

  const tabs: { key: Tab; label: string; icon: string; activeIcon: string }[] = [
    { key: 'SCHEDULE', label: 'Schedule', icon: 'calendar-outline', activeIcon: 'calendar' },
    { key: 'MAP', label: 'Map', icon: 'map-outline', activeIcon: 'map' },
    { key: 'TASKS', label: 'Tasks', icon: 'clipboard-outline', activeIcon: 'clipboard' },
    { key: 'CHAT', label: 'Chat', icon: 'chatbubble-outline', activeIcon: 'chatbubble' },
    { key: 'PROFILE', label: 'Profile', icon: 'person-outline', activeIcon: 'person' },
  ];

  if (screen === 'DAILY_SUMMARY') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f6' }}>
        <DailySummaryScreen onBack={() => setScreen('MAIN')} />
      </View>
    );
  }

  if (screen === 'LEAVE') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f6' }}>
        <LeaveScreen onBack={() => setScreen('MAIN')} />
      </View>
    );
  }

  const renderScreen = () => {
    switch (activeTab) {
      case 'SCHEDULE':
        return (
          <ScreenErrorBoundary screenName="Schedule">
            <ScheduleScreen
              isPunchedIn={isPunchedIn}
              punchInTime={punchInTime}
              onPunchPress={() => setPunchModalVisible(true)}
              onNavigateToMap={() => setActiveTab('MAP')}
              onNavigateToDailySummary={() => setScreen('DAILY_SUMMARY')}
            />
          </ScreenErrorBoundary>
        );
      case 'MAP':
        return <ScreenErrorBoundary screenName="Map"><MapScreen /></ScreenErrorBoundary>;
      case 'TASKS':
        return <ScreenErrorBoundary screenName="Tasks"><TasksScreen /></ScreenErrorBoundary>;
      case 'CHAT':
        return <ScreenErrorBoundary screenName="Chat"><ChatScreen /></ScreenErrorBoundary>;
      case 'PROFILE':
        return (
          <ScreenErrorBoundary screenName="Profile">
            <ProfileScreen
              onSignOut={async () => {
                await clearTokens();
                setIsAuthenticated(false);
                setUserRole(null);
              }}
              onNavigateToLeave={() => setScreen('LEAVE')}
            />
          </ScreenErrorBoundary>
        );
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f6' }}>
      {!isOnline && (
        <View style={{
          backgroundColor: '#fef3c7', paddingTop: insets.top + 4,
          paddingBottom: 6, paddingHorizontal: 16,
          flexDirection: 'row', alignItems: 'center', gap: 6
        }}>
          <Ionicons name="warning-outline" size={14} color="#92400e" />
          <Text style={{ fontSize: 11, color: '#92400e', fontWeight: '500' }}>
            OFFLINE — GPS pings saved locally, will sync on reconnect
          </Text>
        </View>
      )}

      <View style={{ flex: 1 }}>
        {renderScreen()}
      </View>

      <View style={{
        flexDirection: 'row',
        borderTopWidth: 0.5,
        borderTopColor: '#c4c7c7',
        backgroundColor: '#ffffff',
        paddingBottom: insets.bottom,
      }}>
        {tabs.map(tab => {
          const isActive = activeTab === tab.key;
          const showBadge = tab.key === 'CHAT' && chatUnread > 0 && !isActive;
          return (
            <TouchableOpacity
              key={tab.key}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 8 }}
              onPress={() => {
                if (tab.key === 'CHAT') {
                  lastChatVisitRef.current = new Date().toISOString();
                  setChatUnread(0);
                }
                setActiveTab(tab.key);
              }}
            >
              <View style={{ position: 'relative' }}>
                <Ionicons
                  name={(isActive ? tab.activeIcon : tab.icon) as any}
                  size={22}
                  color={isActive ? '#1a1c1a' : '#747878'}
                />
                {showBadge && (
                  <View style={{
                    position: 'absolute', top: -5, right: -8,
                    backgroundColor: '#ba1a1a', borderRadius: 9,
                    minWidth: 16, height: 16,
                    justifyContent: 'center', alignItems: 'center',
                    paddingHorizontal: 3,
                    borderWidth: 1.5, borderColor: '#fff',
                  }}>
                    <Text style={{ color: '#fff', fontSize: 8, fontWeight: '800', lineHeight: 11 }}>
                      {chatUnread > 9 ? '9+' : String(chatUnread)}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{
                fontSize: 9, marginTop: 2,
                color: isActive ? '#1a1c1a' : '#747878',
                fontWeight: isActive ? '500' : '400',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}>
                {tab.label}
              </Text>
              {isActive && (
                <View style={{
                  position: 'absolute', top: 0,
                  width: 32, height: 2,
                  backgroundColor: '#1a1c1a', borderRadius: 1
                }} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <PunchModal
        isVisible={punchModalVisible}
        isPunchedIn={isPunchedIn}
        attendanceLogId={attendanceLogId}
        onClose={() => setPunchModalVisible(false)}
        onPunchInSuccess={(time: string, logId: string) => {
          setIsPunchedIn(true);
          setPunchInTime(time);
          setAttendanceLogId(logId);
          setPunchModalVisible(false);
        }}
        onPunchOutSuccess={() => {
          setIsPunchedIn(false);
          setPunchInTime(null);
          setAttendanceLogId(null);
          setPunchModalVisible(false);
        }}
      />
    </View>
  );
}

export default function App() {
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      await Font.loadAsync({
        'DM-Sans': require('./assets/fonts/DMSans-Regular.ttf'),
        'DM-Sans-Medium': require('./assets/fonts/DMSans-Medium.ttf'),
        'PlayfairDisplay-Bold': require('./assets/fonts/PlayfairDisplay-Bold.ttf'),
      }).catch(() => {});

      setFontsLoaded(true);

      const token = await getAccessToken();
      const role = await getUserRole();
      if (token) {
        setIsAuthenticated(true);
        setUserRole(role);
        registerPushToken();
      }
      setIsCheckingAuth(false);
    }
    init();

    registerLogoutHandler(() => {
      setIsAuthenticated(false);
      setUserRole(null);
    });
  }, []);

  async function registerPushToken() {
    try {
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: 'b127576c-b0cd-419b-81d9-95180fc33ba0',
      });
      await apiFetch('/api/notifications/register-token', {
        method: 'POST',
        body: JSON.stringify({
          token: tokenData.data,
          platform: Platform.OS,
        }),
      });
    } catch {}
  }

  if (!fontsLoaded || isCheckingAuth) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#faf9f6' }}>
          <ActivityIndicator size="large" color="#1a1c1a" />
        </View>
      </SafeAreaProvider>
    );
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaProvider>
        <LoginScreen
          onLoginSuccess={(role: string) => {
            setIsAuthenticated(true);
            setUserRole(role);
          }}
        />
      </SafeAreaProvider>
    );
  }

  if (userRole === 'admin' || userRole === 'manager') {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Ionicons name="desktop-outline" size={48} color="#695d4a" />
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1c1a', marginTop: 16, textAlign: 'center' }}>
            Admin Portal
          </Text>
          <Text style={{ fontSize: 14, color: '#747878', marginTop: 8, textAlign: 'center', lineHeight: 22 }}>
            Please use the web dashboard to manage operations.{'\n\n'}
            <Text style={{ color: '#695d4a', fontWeight: '500' }}>
              http://167.233.90.245:3000
            </Text>
          </Text>
          <TouchableOpacity
            onPress={async () => { await clearTokens(); setIsAuthenticated(false); setUserRole(null); }}
            style={{ marginTop: 32, backgroundColor: '#1a1c1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 4 }}
          >
            <Text style={{ color: '#fff', fontWeight: '500', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>
              Sign Out
            </Text>
          </TouchableOpacity>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
  );
}
