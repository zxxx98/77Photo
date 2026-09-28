import React from 'react';
import {Image, type ImageStyle, type StyleProp} from 'react-native';

type IconName = 'photos' | 'folders' | 'backup' | 'back' | 'next' | 'share' | 'download' | 'settings' | 'video' | 'plus';
type Tone = 'ink' | 'muted' | 'light';
const images = {
  photos: {ink: require('../assets/icons/photos.png'), muted: require('../assets/icons/photos_muted.png'), light: require('../assets/icons/photos_light.png')},
  folders: {ink: require('../assets/icons/folders.png'), muted: require('../assets/icons/folders_muted.png'), light: require('../assets/icons/folders_light.png')},
  backup: {ink: require('../assets/icons/backup.png'), muted: require('../assets/icons/backup_muted.png'), light: require('../assets/icons/backup_light.png')},
  back: {ink: require('../assets/icons/back.png'), muted: require('../assets/icons/back_muted.png'), light: require('../assets/icons/back_light.png')},
  next: {ink: require('../assets/icons/next.png'), muted: require('../assets/icons/next_muted.png'), light: require('../assets/icons/next_light.png')},
  share: {ink: require('../assets/icons/share.png'), muted: require('../assets/icons/share_muted.png'), light: require('../assets/icons/share_light.png')},
  download: {ink: require('../assets/icons/download.png'), muted: require('../assets/icons/download_muted.png'), light: require('../assets/icons/download_light.png')},
  settings: {ink: require('../assets/icons/settings.png'), muted: require('../assets/icons/settings_muted.png'), light: require('../assets/icons/settings_light.png')},
  video: {ink: require('../assets/icons/video.png'), muted: require('../assets/icons/video_muted.png'), light: require('../assets/icons/video_light.png')},
  plus: {ink: require('../assets/icons/plus.png'), muted: require('../assets/icons/plus_muted.png'), light: require('../assets/icons/plus_light.png')},
};
export default function Icon({name, tone = 'ink', size = 24, style}: {name: IconName; tone?: Tone; size?: number; style?: StyleProp<ImageStyle>}) {
  return <Image source={images[name][tone]} style={[{width: size, height: size}, style]} resizeMode="contain" />;
}
