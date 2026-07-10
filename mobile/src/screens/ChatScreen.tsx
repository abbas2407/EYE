import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch, getUserName } from '../api/client';

interface Room {
  id: string;
  name: string;
  room_type: string;
  last_message?: string;
  last_message_time?: string;
  last_sender?: string;
}

interface ChatMessage {
  id: string;
  content: string;
  sender_id: string;
  sender_name: string;
  created_at: string;
  is_me: boolean;
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return ''; }
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function RoomList({ rooms, onSelect, loading }: {
  rooms: Room[]; onSelect: (r: Room) => void; loading: boolean;
}) {
  if (loading) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator size="large" color="#695d4a" />
    </View>
  );
  if (rooms.length === 0) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
      <Ionicons name="chatbubbles-outline" size={48} color="#c4c7c7" />
      <Text style={{ fontSize: 15, color: '#747878', fontFamily: 'DM-Sans', marginTop: 12, textAlign: 'center' }}>
        No chat rooms yet
      </Text>
    </View>
  );
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 8, marginTop: 8 }}>
        {rooms.map(room => (
          <TouchableOpacity
            key={room.id}
            onPress={() => onSelect(room)}
            style={{ backgroundColor: '#fff', borderRadius: 10, padding: 14, borderWidth: 0.5, borderColor: '#e3e2e0', flexDirection: 'row', alignItems: 'center', gap: 12 }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#f2e0c8', justifyContent: 'center', alignItems: 'center' }}>
              <Ionicons name={room.room_type === 'group' ? 'people' : 'person'} size={20} color="#695d4a" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                  {room.name}
                </Text>
                {room.last_message_time && (
                  <Text style={{ fontSize: 10, color: '#c4c7c7', fontFamily: 'DM-Sans' }}>
                    {formatDate(room.last_message_time)}
                  </Text>
                )}
              </View>
              {room.last_message && (
                <Text style={{ fontSize: 12, color: '#747878', fontFamily: 'DM-Sans', marginTop: 2 }} numberOfLines={1}>
                  {room.last_sender ? `${room.last_sender}: ` : ''}{room.last_message}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function ChatRoom({ room, myName, onBack }: { room: Room; myName: string; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/chat/messages/${room.id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(Array.isArray(data) ? data : []);
      }
    } catch {}
    finally { setLoading(false); }
  }, [room.id]);

  useEffect(() => {
    fetchMessages();
    pollRef.current = setInterval(fetchMessages, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 100);
  }, [messages]);

  async function sendMessage() {
    const text = message.trim();
    if (!text) return;
    setSending(true);
    setMessage('');
    try {
      const res = await apiFetch(`/api/chat/messages/${room.id}`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      });
      if (res.ok) await fetchMessages();
    } catch {}
    finally { setSending(false); }
  }

  let lastDate = '';

  return (
    <View style={{ flex: 1 }}>
      {/* Room header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: '#e3e2e0', backgroundColor: '#fff', gap: 12 }}>
        <TouchableOpacity onPress={onBack} style={{ padding: 4 }}>
          <Ionicons name="arrow-back" size={22} color="#1a1c1a" />
        </TouchableOpacity>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#f2e0c8', justifyContent: 'center', alignItems: 'center' }}>
          <Ionicons name={room.room_type === 'group' ? 'people' : 'person'} size={18} color="#695d4a" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>{room.name}</Text>
          <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans' }}>
            {room.room_type === 'group' ? 'Group Chat' : 'Direct Message'}
          </Text>
        </View>
      </View>

      {/* Messages */}
      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color="#695d4a" />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 16, paddingBottom: 8, gap: 8 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {messages.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans' }}>No messages yet. Say hello!</Text>
            </View>
          )}
          {messages.map((msg) => {
            const dateLabel = formatDate(msg.created_at);
            const showDate = dateLabel !== lastDate;
            if (showDate) lastDate = dateLabel;
            return (
              <View key={msg.id}>
                {showDate && (
                  <View style={{ alignItems: 'center', marginVertical: 8 }}>
                    <Text style={{ fontSize: 10, color: '#c4c7c7', fontFamily: 'DM-Sans', backgroundColor: '#faf9f6', paddingHorizontal: 12, paddingVertical: 3, borderRadius: 10 }}>
                      {dateLabel}
                    </Text>
                  </View>
                )}
                <View style={{ flexDirection: msg.is_me ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8 }}>
                  {!msg.is_me && (
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#f2e0c8', justifyContent: 'center', alignItems: 'center' }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#695d4a' }}>
                        {msg.sender_name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={{ maxWidth: '72%' }}>
                    {!msg.is_me && (
                      <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans', marginBottom: 3, marginLeft: 2 }}>
                        {msg.sender_name}
                      </Text>
                    )}
                    <View style={{
                      backgroundColor: msg.is_me ? '#1a1c1a' : '#fff',
                      borderRadius: msg.is_me ? 14 : 14,
                      borderTopRightRadius: msg.is_me ? 4 : 14,
                      borderTopLeftRadius: msg.is_me ? 14 : 4,
                      padding: 10,
                      borderWidth: msg.is_me ? 0 : 0.5,
                      borderColor: '#e3e2e0',
                    }}>
                      <Text style={{ fontSize: 13, color: msg.is_me ? '#fff' : '#1a1c1a', fontFamily: 'DM-Sans', lineHeight: 18 }}>
                        {msg.content}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 9, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 2, textAlign: msg.is_me ? 'right' : 'left' }}>
                      {formatTime(msg.created_at)}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Input */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 0.5, borderTopColor: '#e3e2e0', backgroundColor: '#fff', gap: 8 }}>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="Type a message..."
            placeholderTextColor="#c4c7c7"
            multiline
            maxLength={1000}
            style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, fontFamily: 'DM-Sans', color: '#1a1c1a', maxHeight: 100 }}
          />
          <TouchableOpacity
            onPress={sendMessage}
            disabled={sending || !message.trim()}
            style={{
              width: 40, height: 40, borderRadius: 20,
              backgroundColor: message.trim() ? '#1a1c1a' : '#e3e2e0',
              justifyContent: 'center', alignItems: 'center',
            }}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="send" size={16} color={message.trim() ? '#fff' : '#c4c7c7'} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default function ChatScreen() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [myName, setMyName] = useState('');

  useEffect(() => {
    getUserName().then(n => setMyName(n ?? ''));
    fetchRooms();
  }, []);

  const fetchRooms = useCallback(async () => {
    try {
      const res = await apiFetch('/api/chat/rooms');
      if (res.ok) setRooms(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      {!activeRoom ? (
        <>
          <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
            <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
              Team
            </Text>
            <Text style={{ fontSize: 26, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
              Messages
            </Text>
          </View>
          <RoomList rooms={rooms} onSelect={setActiveRoom} loading={loading} />
        </>
      ) : (
        <ChatRoom room={activeRoom} myName={myName} onBack={() => setActiveRoom(null)} />
      )}
    </SafeAreaView>
  );
}
