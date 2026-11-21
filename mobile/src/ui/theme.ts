import {StyleSheet} from 'react-native';

/**
 * Shared warm-paper editorial palette matching the 77Photo web workspace.
 * Avoids harsh pure grays, heavy card borders, and inconsistent accent colors.
 */
export const colors = {
  paper: '#FAF9F7',
  recessed: '#F3F0EC',
  surface: '#FFFFFF',
  ink: '#3D4A5C',
  muted: '#6E7886',
  subtle: '#9AA3AE',
  border: '#E6E1DA',
  hairline: '#ECE8E1',
  blush: '#D4A5A5',
  blushSoft: '#F4E8E7',
  sage: '#7A9E8E',
  sageBar: '#A8C5B8',
  sageSoft: '#EAF2EE',
  sand: '#E8D4B8',
  sandSoft: '#F7F1E7',
  danger: '#B5433A',
  dangerSoft: '#F9ECEA',
  viewerBg: '#11151A',
  viewerSheet: '#191F27',
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 14,
  pill: 999,
} as const;

export const hairline = StyleSheet.hairlineWidth;
