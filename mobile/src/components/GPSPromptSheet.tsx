import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Animated, Easing,
  TouchableWithoutFeedback, Platform, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface GPSPromptSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onTurnOn: () => void;
}

export default function GPSPromptSheet({ visible, onDismiss, onTurnOn }: GPSPromptSheetProps) {
  const [mounted, setMounted] = useState(false);
  const slideAnim = useRef(new Animated.Value(400)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(slideAnim, {
        toValue: 400,
        duration: 220,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
  }, [visible]);

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Dim backdrop — tap to dismiss */}
      <TouchableWithoutFeedback onPress={onDismiss}>
        <View style={{ flex: 1 }} />
      </TouchableWithoutFeedback>

      {/* Sliding sheet */}
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
      >
        {/* Heading */}
        <Text style={styles.heading}>
          For a better experience, your device will need to use Location
        </Text>

        {/* Sub-heading */}
        <Text style={styles.subheading}>The following settings should be on:</Text>

        {/* Row 1 */}
        <View style={styles.row}>
          <Ionicons name="location-outline" size={20} color="#695d4a" />
          <Text style={styles.rowTextWhite}>Device location</Text>
        </View>

        {/* Row 2 */}
        <View style={[styles.row, { alignItems: 'flex-start', marginBottom: 18 }]}>
          <Ionicons name="radio-button-on-outline" size={20} color="#695d4a" style={{ marginTop: 1 }} />
          <Text style={[styles.rowTextMuted, { flex: 1 }]}>
            Location Accuracy — enables precise GPS for punch-in and tracking
          </Text>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Footer */}
        <Text style={styles.footer}>
          You can change this at any time in location settings.
        </Text>

        {/* Action buttons */}
        <View style={styles.actions}>
          <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.btnSecondary}>No, thanks</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onTurnOn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.btnPrimary}>
              {Platform.OS === 'ios' ? 'Open Settings' : 'Turn on'}
            </Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: 'rgba(42, 42, 42, 0.97)',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 36,
  },
  heading: {
    fontFamily: 'DM-Sans-Medium',
    fontSize: 16,
    color: '#ffffff',
    lineHeight: 24,
    marginBottom: 12,
  },
  subheading: {
    fontFamily: 'DM-Sans',
    fontSize: 13,
    color: '#cccccc',
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  rowTextWhite: {
    fontFamily: 'DM-Sans',
    fontSize: 13,
    color: '#ffffff',
  },
  rowTextMuted: {
    fontFamily: 'DM-Sans',
    fontSize: 12,
    color: '#cccccc',
    lineHeight: 18,
  },
  divider: {
    height: 0.5,
    backgroundColor: '#444444',
    marginBottom: 12,
  },
  footer: {
    fontFamily: 'DM-Sans',
    fontSize: 11,
    color: '#aaaaaa',
    marginBottom: 18,
    lineHeight: 16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 28,
  },
  btnSecondary: {
    fontFamily: 'DM-Sans-Medium',
    fontSize: 14,
    color: '#695d4a',
  },
  btnPrimary: {
    fontFamily: 'DM-Sans-Medium',
    fontSize: 14,
    color: '#695d4a',
    fontWeight: '600',
  },
});
