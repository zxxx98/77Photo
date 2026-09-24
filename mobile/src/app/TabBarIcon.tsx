import React from 'react';
import { StyleSheet, View } from 'react-native';

type TabName = 'gallery' | 'upload' | 'folders' | 'settings';

export function TabBarIcon({ name, color }: { name: TabName; color: string }) {
  return (
    <View accessible={false} style={styles.icon}>
      {name === 'gallery' ? <GalleryIcon color={color} /> : null}
      {name === 'upload' ? <UploadIcon color={color} /> : null}
      {name === 'folders' ? <FoldersIcon color={color} /> : null}
      {name === 'settings' ? <SettingsIcon color={color} /> : null}
    </View>
  );
}

function GalleryIcon({ color }: { color: string }) {
  return (
    <View style={[styles.galleryFrame, { borderColor: color }]}>
      <View style={[styles.sun, { backgroundColor: color }]} />
      <View style={[styles.mountainBack, { borderColor: color }]} />
      <View style={[styles.mountainFront, { borderColor: color }]} />
    </View>
  );
}

function UploadIcon({ color }: { color: string }) {
  return (
    <View style={styles.uploadCanvas}>
      <View style={[styles.arrowStem, { backgroundColor: color }]} />
      <View style={[styles.arrowLeft, { borderColor: color }]} />
      <View style={[styles.arrowRight, { borderColor: color }]} />
      <View style={[styles.tray, { borderColor: color }]} />
    </View>
  );
}

function FoldersIcon({ color }: { color: string }) {
  return (
    <View style={styles.folderCanvas}>
      <View style={[styles.folderBack, { borderColor: color, backgroundColor: color }]} />
      <View style={[styles.folderFront, { borderColor: color }]} />
    </View>
  );
}

function SettingsIcon({ color }: { color: string }) {
  return (
    <View style={styles.gearCanvas}>
      <View style={[styles.gearCore, { borderColor: color }]} />
      <View style={[styles.gearCenter, { backgroundColor: color }]} />
      <View style={[styles.gearTooth, styles.gearToothTop, { backgroundColor: color }]} />
      <View style={[styles.gearTooth, styles.gearToothBottom, { backgroundColor: color }]} />
      <View style={[styles.gearTooth, styles.gearToothLeft, { backgroundColor: color }]} />
      <View style={[styles.gearTooth, styles.gearToothRight, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  galleryFrame: {
    width: 21,
    height: 17,
    borderWidth: 2,
    borderRadius: 3,
    overflow: 'hidden',
  },
  sun: { position: 'absolute', width: 3, height: 3, borderRadius: 2, top: 3, right: 3 },
  mountainBack: {
    position: 'absolute',
    width: 9,
    height: 9,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    left: 2,
    bottom: -4,
    transform: [{ rotate: '45deg' }],
  },
  mountainFront: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    right: 1,
    bottom: -4,
    transform: [{ rotate: '45deg' }],
  },
  uploadCanvas: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-start' },
  arrowStem: { width: 2, height: 10, position: 'absolute', top: 2 },
  arrowLeft: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    top: 2,
    left: 5,
    transform: [{ rotate: '45deg' }],
  },
  arrowRight: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderRightWidth: 2,
    borderTopWidth: 2,
    top: 2,
    right: 5,
    transform: [{ rotate: '-45deg' }],
  },
  tray: {
    position: 'absolute',
    width: 20,
    height: 7,
    borderWidth: 2,
    borderTopWidth: 0,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    bottom: 1,
  },
  folderCanvas: { width: 23, height: 20, justifyContent: 'flex-end' },
  folderBack: {
    position: 'absolute',
    width: 17,
    height: 12,
    borderWidth: 1,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 2,
    top: 1,
    left: 1,
    opacity: 0.35,
  },
  folderFront: {
    width: 22,
    height: 14,
    borderWidth: 2,
    borderRadius: 3,
    backgroundColor: 'transparent',
  },
  gearCanvas: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  gearCore: { width: 15, height: 15, borderWidth: 3, borderRadius: 8 },
  gearCenter: { position: 'absolute', width: 4, height: 4, borderRadius: 2 },
  gearTooth: { position: 'absolute', width: 4, height: 6, borderRadius: 1 },
  gearToothTop: { top: 0 },
  gearToothBottom: { bottom: 0 },
  gearToothLeft: { left: 0, transform: [{ rotate: '90deg' }] },
  gearToothRight: { right: 0, transform: [{ rotate: '90deg' }] },
});
