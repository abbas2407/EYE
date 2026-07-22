import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Path, Ellipse } from 'react-native-svg';

interface FieldPulseLogoProps {
  size?: number;
  variant?: 'light' | 'dark';
  showTagline?: boolean;
}

// Geometry (viewBox 0 0 100 100):
//   Hexagon — pointy-top, center (50,48), radius 38
//   Pin cutout — circle center (50,41) radius 12, tip at (50,68)
//   Both combined as evenodd compound path for clean negative-space cutout
//   ECG line — polyline through circle area, drawn over transparent pin hole
//   Shadow oval — below hex bottom vertex

export default function FieldPulseLogo({
  size = 80,
  variant = 'light',
  showTagline = false,
}: FieldPulseLogoProps) {
  const hexFill    = variant === 'light' ? '#1a1c1a' : '#faf9f6';
  const fieldColor = variant === 'light' ? '#1a1c1a' : '#faf9f6';
  const pulseColor = '#695d4a';

  const wordmarkSize = Math.round(size * 0.22);
  const taglineSize  = Math.round(size * 0.09);

  // Hex vertices (pointy-top CW):
  //   top (50,10), (82.91,29), (82.91,67), (50,86), (17.09,67), (17.09,29)
  // Pin silhouette (CW arcs + lines, used as evenodd hole):
  //   circle center (50,41) r=12 — top (50,29), right tangent (60.39,47),
  //   tip (50,68), left tangent (39.61,47)
  const compoundPath =
    'M50,10 L82.91,29 L82.91,67 L50,86 L17.09,67 L17.09,29 Z ' +
    'M50,29 A12,12 0 0,1 60.39,47 L50,68 L39.61,47 A12,12 0 0,1 50,29 Z';

  // ECG / pulse line — drawn inside pin circle area (≈ x:39–61, y:35–47)
  const ecgPath =
    'M39,41 L42,41 L44,34 L46,48 L48,41 L50,39 L52,43 L54,41 L61,41';

  return (
    <View style={{ alignItems: 'center' }}>
      {/* ── Mark ── */}
      <Svg width={size} height={size} viewBox="0 0 100 100">
        {/* Shadow oval below hexagon */}
        <Ellipse
          cx="50" cy="92" rx="16" ry="2.5"
          fill="#695d4a" fillOpacity="0.35"
        />

        {/* Hexagon with pin-shaped negative-space cutout */}
        <Path
          d={compoundPath}
          fill={hexFill}
          fillRule="evenodd"
        />

        {/* ECG/pulse line inside pin circle window */}
        <Path
          d={ecgPath}
          stroke={hexFill}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>

      {/* ── Wordmark ── */}
      <View style={{ flexDirection: 'row', marginTop: 6 }}>
        <Text
          style={{
            fontFamily: 'DM-Sans-Medium',
            fontSize: wordmarkSize,
            color: fieldColor,
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          FIELD
        </Text>
        <Text
          style={{
            fontFamily: 'DM-Sans-Medium',
            fontSize: wordmarkSize,
            color: pulseColor,
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          PULSE
        </Text>
      </View>

      {/* ── Tagline ── */}
      {showTagline && (
        <Text
          style={{
            fontFamily: 'DM-Sans',
            fontSize: taglineSize,
            color: pulseColor,
            textTransform: 'uppercase',
            letterSpacing: 3,
            marginTop: 5,
          }}
        >
          FIELD OPERATIONS PLATFORM
        </Text>
      )}
    </View>
  );
}
