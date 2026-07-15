import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Image
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
  unread_count?: number;
}

interface ChatMessage {
  id: string;
  content: string;
  sender_id: string;
  sender_name: string;
  created_at: string;
  is_me: boolean;
}

interface UserItem {
  id: string;
  name: string;
  role: string;
  photo_url?: string;
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); }
  catch { return ''; }
}

function formatRoomTime(iso: string) {
  try {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function formatDateLabel(iso: string) {
  try {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function Avatar({ name, photoUrl, size = 38 }: { name: string; photoUrl?: string; size?: number }) {
  if (photoUrl) return (
    <Image source={{ uri: photoUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  );
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#f2e0c8', justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: size * 0.38, fontWeight: '700', color: '#695d4a' }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

// ── Chat Room View ────────────────────────────────────────────────────────────
function ChatRoomView({ room, onBack }: { room: Room; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/chat/messages/${room.id}`);
      if (res.ok) setMessages(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, [room.id]);

  useEffect(() => {
    // Mark room as read when opened
    apiFetch(`/api/chat/rooms/${room.id}/mark-read`, { method: 'POST' }).catch(() => {});
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

  let lastDateLabel = '';

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
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
          contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {messages.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Ionicons name="chatbubble-outline" size={36} color="#c4c7c7" />
              <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 10 }}>
                No messages yet. Start the conversation!
              </Text>
            </View>
          )}
          {messages.map((msg) => {
            const dateLabel = formatDateLabel(msg.created_at);
            const showDate = dateLabel !== lastDateLabel;
            if (showDate) lastDateLabel = dateLabel;
            return (
              <View key={msg.id}>
                {showDate && (
                  <View style={{ alignItems: 'center', marginVertical: 12 }}>
                    <Text style={{ fontSize: 10, color: '#c4c7c7', fontFamily: 'DM-Sans', backgroundColor: '#faf9f6', paddingHorizontal: 12, paddingVertical: 3, borderRadius: 10 }}>
                      {dateLabel}
                    </Text>
                  </View>
                )}
                <View style={{ flexDirection: msg.is_me ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8, marginBottom: 8 }}>
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
                      borderRadius: 14,
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
            {sending ? <ActivityIndicator size="small" color="#fff" /> : (
              <Ionicons name="send" size={16} color={message.trim() ? '#fff' : '#c4c7c7'} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── New DM Modal ──────────────────────────────────────────────────────────────
function NewDMModal({ visible, onClose, onSelect }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (user: UserItem) => void;
}) {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    apiFetch('/api/users/list').then(async res => {
      if (res?.ok) setUsers(await res.json());
    }).finally(() => setLoading(false));
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#e3e2e0' }}>
          <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>New Message</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={22} color="#1a1c1a" />
          </TouchableOpacity>
        </View>
        <Text style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
          Select a person to message
        </Text>
        {loading ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator color="#695d4a" />
          </View>
        ) : (
          <ScrollView>
            {users.map(u => (
              <TouchableOpacity
                key={u.id}
                onPress={() => onSelect(u)}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#f0efec', gap: 12 }}
              >
                <Avatar name={u.name} photoUrl={u.photo_url} size={44} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>{u.name}</Text>
                  <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans', marginTop: 1, textTransform: 'capitalize' }}>
                    {u.role.replace('_', ' ')}
                  </Text>
                </View>
                <Ionicons name="chatbubble-outline" size={18} color="#c4c7c7" />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ── Room List ─────────────────────────────────────────────────────────────────
export default function ChatScreen() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [showNewDM, setShowNewDM] = useState(false);
  const [openingDM, setOpeningDM] = useState(false);

  const fetchRooms = useCallback(async () => {
    try {
      const res = await apiFetch('/api/chat/rooms');
      if (res?.ok) setRooms(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchRooms(); }, []);

  async function openDMWithUser(user: UserItem) {
    setShowNewDM(false);
    setOpeningDM(true);
    try {
      const res = await apiFetch(`/api/chat/direct/${user.id}`, { method: 'POST' });
      if (res?.ok) {
        const room = await res.json();
        await fetchRooms();
        setActiveRoom({ id: room.id, name: room.name, room_type: 'direct' });
      }
    } catch {}
    finally { setOpeningDM(false); }
  }

  if (activeRoom) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top']}>
        <ChatRoomView room={activeRoom} onBack={() => { setActiveRoom(null); fetchRooms(); }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>Team</Text>
          <Text style={{ fontSize: 26, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>Messages</Text>
        </View>
        <TouchableOpacity
          onPress={() => setShowNewDM(true)}
          style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: '#1a1c1a', justifyContent: 'center', alignItems: 'center' }}
        >
          <Ionicons name="create-outline" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {openingDM && (
        <View style={{ paddingHorizontal: 20, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color="#695d4a" />
          <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans' }}>Opening conversation...</Text>
        </View>
      )}

      {/* Section: Group chats */}
      {rooms.filter(r => r.room_type === 'group').length > 0 && (
        <Text style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 6, fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
          Group Chats
        </Text>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#695d4a" />
        </View>
      ) : rooms.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Ionicons name="chatbubbles-outline" size={48} color="#c4c7c7" />
          <Text style={{ fontSize: 15, color: '#747878', fontFamily: 'DM-Sans', marginTop: 12, textAlign: 'center' }}>
            No messages yet
          </Text>
          <TouchableOpacity
            onPress={() => setShowNewDM(true)}
            style={{ marginTop: 20, backgroundColor: '#1a1c1a', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <Ionicons name="create-outline" size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontFamily: 'DM-Sans', textTransform: 'uppercase', letterSpacing: 0.8 }}>Start a conversation</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Group rooms */}
          {rooms.filter(r => r.room_type === 'group').map(room => (
            <RoomRow key={room.id} room={room} onPress={() => setActiveRoom(room)} />
          ))}

          {/* Direct messages */}
          {rooms.filter(r => r.room_type === 'direct').length > 0 && (
            <Text style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6, fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
              Direct Messages
            </Text>
          )}
          {rooms.filter(r => r.room_type === 'direct').map(room => (
            <RoomRow key={room.id} room={room} onPress={() => setActiveRoom(room)} />
          ))}

          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      <NewDMModal
        visible={showNewDM}
        onClose={() => setShowNewDM(false)}
        onSelect={openDMWithUser}
      />
    </SafeAreaView>
  );
}

function RoomRow({ room, onPress }: { room: Room; onPress: () => void }) {
  const hasUnread = (room.unread_count ?? 0) > 0;
  const unreadLabel = !hasUnread ? '' :
    room.unread_count === 1 ? '1' : `${room.unread_count}+ messages`;
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 6, borderRadius: 10, padding: 14, borderWidth: hasUnread ? 1 : 0.5, borderColor: hasUnread ? '#1a1c1a' : '#e3e2e0', flexDirection: 'row', alignItems: 'center', gap: 12 }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#f2e0c8', justifyContent: 'center', alignItems: 'center' }}>
        <Ionicons name={room.room_type === 'group' ? 'people' : 'person'} size={20} color="#695d4a" />
      </View>
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 14, fontWeight: hasUnread ? '700' : '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }} numberOfLines={1}>
            {room.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {room.last_message_time && (
              <Text style={{ fontSize: 10, color: hasUnread ? '#695d4a' : '#c4c7c7', fontFamily: 'DM-Sans' }}>
                {formatRoomTime(room.last_message_time)}
              </Text>
            )}
            {hasUnread && (
              <View style={{ backgroundColor: '#1a1c1a', borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5 }}>
                <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>
                  {(room.unread_count ?? 0) > 9 ? '9+' : String(room.unread_count)}
                </Text>
              </View>
            )}
          </View>
        </View>
        {room.last_message ? (
          <Text style={{ fontSize: 12, color: hasUnread ? '#1a1c1a' : '#747878', fontFamily: 'DM-Sans', fontWeight: hasUnread ? '600' : '400', marginTop: 2 }} numberOfLines={1}>
            {room.last_sender ? `${room.last_sender}: ` : ''}{room.last_message}
          </Text>
        ) : (
          <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 2 }}>No messages yet</Text>
        )}
        {hasUnread && room.unread_count! > 1 && (
          <Text style={{ fontSize: 10, color: '#695d4a', fontFamily: 'DM-Sans', marginTop: 2 }}>
            {unreadLabel}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}
