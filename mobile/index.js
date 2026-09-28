/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { backgroundBackup } from './src/backup/service';

AppRegistry.registerComponent(appName, () => App);
AppRegistry.registerHeadlessTask('Photo77Backup', () => backgroundBackup);
