import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {ApiError, checkServer, login, revokeDevice} from './src/auth/api';
import {restoreSession} from './src/auth/controller';
import {IdentityError, ServerConnection, verifyAddress, type ServerProfile} from './src/auth/connection';
import {normalizeServer} from './src/auth/server';
import {clearSession, loadLastServer, loadLastProfile, loadSession, saveSession, type MobileSession} from './src/auth/session';
import BrowseApp from './src/browse/BrowseApp';
import {clearQueue} from './src/upload/queue';
import {disableBackup, enterBackupUI, leaveBackupUI} from './src/backup/service';
import {colors, hairline, radius} from './src/ui/theme';

function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INVALID_CREDENTIALS') {return '账号或密码错误';}
    if (error.code === 'LOGIN_RATE_LIMITED') {return '尝试次数过多，请稍后重试';}
    if (error.status === 404) {return '服务器版本不支持移动端登录';}
    if (error.status === 401) {return '登录已失效，请重新登录';}
    return error.message || `服务器返回错误 ${error.status}`;
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return '无法连接服务器，请检查地址、网络和 TLS 证书';
  }
  return error instanceof Error ? error.message : '发生未知错误';
}

function Main() {
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState('');
  const [backups, setBackups] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [session, setSession] = useState<MobileSession | null>(null);
  const [pending, setPending] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');

  async function resume(saved: MobileSession) {
    setPending(true);
    setError('');
    try {
      const valid = await restoreSession(saved);
      setSession(valid);
      setUsername(valid.username);
    } catch (problem) {
      setError(message(problem));
      setSession(await loadSession().catch(() => null));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await enterBackupUI();
        const [lastServer, saved] = await Promise.all([loadLastServer(), loadSession()]);
        if (!active) {return;}
        setServer(saved?.server ?? lastServer);
        if (saved?.userId) {
          // Open the library at once instead of waiting for the network. From
          // here BrowseApi alone probes addresses and rotates the token, so no
          // second refresh can race it; it reports a revoked device via `expired`.
          setUsername(saved.username);
          setSession(saved);
        } else if (saved) {await resume(saved);}
      } catch (problem) {
        if (active) {setError(message(problem));}
      } finally {
        if (active) {setBooting(false);}
      }
    })();
    return () => {active = false; leaveBackupUI();};
  }, []);

  async function submitLogin() {
    if (pending) {return;}
    setError('');
    let address: string;
    try {
      address = normalizeServer(server);
      if (!username.trim() || !password) {throw new Error('请输入账号和密码');}
    } catch (problem) {
      setError(message(problem));
      return;
    }
    setPending(true);
    try {
      const extraAddresses = backups.filter(value => value.trim()).map(normalizeServer);
      const previous = await loadLastProfile();
      let profile: ServerProfile = {id: address, addresses: [{url: address, name: '默认地址', verified: false}]};
      if (previous?.publicKey && previous.addresses.some(a => a.url === address && a.verified)) {
        profile = previous;
        address = await new ServerConnection().resolve({server: address, profile});
      }
      try {
        await checkServer(address);
      } catch (problem) {
        if (problem instanceof TypeError || (problem instanceof Error && problem.name === 'AbortError')) {
          throw new Error(`App 无法访问 ${address}/healthz，请检查地址和 Android 网络权限`);
        }
        throw problem;
      }
      try {
        const publicKey = await verifyAddress(address, profile.publicKey);
        profile = {...profile, publicKey, addresses: profile.addresses.map(a => a.url === address ? {...a, verified: true} : a)};
      } catch (problem) {
        // The address was entered by the user and passed the health check.
        // Existing servers can still use it for login; alternative addresses
        // stay pending until this server can prove its identity.
        if (problem instanceof IdentityError || profile.publicKey) {throw problem;}
      }
      for (const url of extraAddresses) {
        if (profile.addresses.some(a => a.url === url)) {continue;}
        if (profile.addresses.length >= 8) {throw new Error('最多添加 8 个地址');}
        let verified = false;
        if (profile.publicKey) {
          try {await verifyAddress(url, profile.publicKey); verified = true;} catch (problem) {if (problem instanceof IdentityError) {throw problem;}}
        }
        profile.addresses.push({url, name: '备用地址', verified});
      }
      let signedIn: MobileSession;
      try {
        signedIn = {...await login(address, username.trim(), password), profile};
      } catch (problem) {
        if (problem instanceof TypeError || (problem instanceof Error && problem.name === 'AbortError')) {
          throw new Error(`已连接 ${address}，但发送登录请求时网络中断`);
        }
        throw problem;
      }
      try {
        await saveSession(signedIn);
      } catch (storageError) {
        await revokeDevice(signedIn).catch(() => {});
        throw storageError;
      }
      setPassword('');
      setServer(address);
      setSession(signedIn);
    } catch (problem) {
      setError(message(problem));
    } finally {
      setPending(false);
    }
  }

  async function expired() {
    // Leave the library only once the stored credentials are really gone.
    const stored = await loadSession().catch(() => undefined);
    if (stored !== null) {return;}
    setError('登录已失效，请重新登录');
    setSession(null);
  }

  async function signOut() {
    if (!session || pending) {return;}
    setPending(true);
    setError('');
    try {
      await disableBackup(session);
      // A background backup may have rotated credentials before cancellation.
      const valid = await restoreSession(await loadSession() ?? session);
      await clearQueue(valid);
      await revokeDevice(valid);
      await clearSession();
      setSession(null);
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 401) {
        await clearQueue(session);
        await clearSession();
        setSession(null);
      } else {
        setError(`注销失败，设备会话仍保留：${message(problem)}`);
        setSession(await loadSession().catch(() => null));
      }
    } finally {
      setPending(false);
    }
  }

  if (session && !booting) {
    return <BrowseApp session={session} onSession={setSession} onSignOut={signOut} onExpired={expired} error={error} />;
  }

  return <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
    <StatusBar barStyle="dark-content" />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.container}>
        <View style={styles.brandRow}>
          <View style={styles.brand}>
            <Text style={styles.brandText}>77</Text>
            <View style={styles.brandDot} />
          </View>
          <Text style={styles.brandName}>77Photo</Text>
        </View>
        <Text style={styles.heading}>连接服务器</Text>
        <Text style={styles.subtitle}>使用你的私人相册服务账号登录</Text>

        {booting ? <ActivityIndicator style={styles.bootSpinner} color={colors.ink} /> : <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>服务器地址</Text>
            <TextInput style={styles.input} value={server} onChangeText={setServer}
              placeholder="https://photos.example.com" placeholderTextColor={colors.subtle}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="服务器地址" editable={!pending} />
            {server.trim().toLowerCase().startsWith('http://') ?
              <Text style={styles.warning}>HTTP 连接未加密，账号和照片可能被同一网络中的设备读取，请仅在可信内网使用。</Text> : null}
          </View>

          {backups.map((value, index) => <View key={index} style={styles.field}>
            <View style={styles.backupHeader}>
              <Text style={styles.label}>备用地址 {index + 1}</Text>
              <Pressable disabled={pending} accessibilityRole="button" hitSlop={8}
                onPress={() => setBackups(old => old.filter((_, i) => i !== index))}>
                <Text style={styles.removeLink}>删除</Text>
              </Pressable>
            </View>
            <TextInput style={styles.input} value={value}
              onChangeText={text => setBackups(old => old.map((item, i) => i === index ? text : item))}
              placeholder="http://100.90.1.10:8080" placeholderTextColor={colors.subtle}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel={`备用地址 ${index + 1}`} editable={!pending} />
            {value.trim().toLowerCase().startsWith('http://') ?
              <Text style={styles.warning}>HTTP 连接未加密，请仅在可信内网或加密组网中使用。</Text> : null}
          </View>)}

          {backups.length < 7 ? <Pressable disabled={pending} accessibilityRole="button" style={styles.addBackup}
            onPress={() => setBackups(old => [...old, ''])}>
            <Text style={styles.addBackupText}>+ 添加备用地址</Text>
          </Pressable> : null}
          {backups.length ? <Text style={styles.hint}>备用地址验证通过后自动启用；离线地址可登录后在设置中验证。</Text> : null}

          <View style={styles.divider} />

          <View style={styles.field}>
            <Text style={styles.label}>账号</Text>
            <TextInput style={styles.input} value={username} onChangeText={setUsername}
              placeholder="用户名" placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false}
              textContentType="username" accessibilityLabel="账号" editable={!pending} />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>密码</Text>
            <View style={styles.passwordRow}>
              <TextInput style={styles.passwordInput} value={password} onChangeText={setPassword}
                placeholder="输入密码" placeholderTextColor={colors.subtle} secureTextEntry={!showPassword}
                textContentType="password" accessibilityLabel="密码" editable={!pending} />
              <Pressable style={styles.reveal} accessibilityRole="button"
                accessibilityLabel={showPassword ? '隐藏密码' : '显示密码'} onPress={() => setShowPassword(!showPassword)}>
                <Text style={styles.revealText}>{showPassword ? '隐藏' : '显示'}</Text>
              </Pressable>
            </View>
          </View>

          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button title={pending ? '正在登录…' : '登录'} disabled={pending} onPress={submitLogin} />
        </View>}
      </View>
    </ScrollView>
  </View>;
}

function Button({title, disabled, onPress}: {title: string; disabled: boolean; onPress: () => void}) {
  return <Pressable style={({pressed}) => [styles.button, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
    disabled={disabled} onPress={onPress} accessibilityRole="button">
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>;
}

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.paper},
  content: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 42, paddingBottom: 36, alignItems: 'center'},
  container: {width: '100%', maxWidth: 420},
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 28},
  brand: {width: 34, height: 34, borderRadius: 10, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', position: 'relative'},
  brandText: {color: colors.paper, fontSize: 15, fontWeight: '700', letterSpacing: -0.5},
  brandDot: {position: 'absolute', right: 4, bottom: 4, width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.sageBar},
  brandName: {color: colors.ink, fontSize: 16, fontWeight: '700', letterSpacing: -0.3},
  heading: {fontSize: 28, fontWeight: '700', color: colors.ink, letterSpacing: -0.6},
  subtitle: {color: colors.muted, fontSize: 14, marginTop: 6, marginBottom: 28},
  bootSpinner: {marginTop: 32, alignSelf: 'flex-start'},
  form: {gap: 14},
  field: {gap: 6},
  label: {fontSize: 13, fontWeight: '600', color: colors.ink},
  input: {height: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 15, color: colors.ink, backgroundColor: colors.surface},
  passwordRow: {height: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface},
  passwordInput: {flex: 1, height: 46, paddingHorizontal: 14, fontSize: 15, color: colors.ink},
  reveal: {minWidth: 52, height: 46, justifyContent: 'center', alignItems: 'center'},
  revealText: {color: colors.muted, fontSize: 13, fontWeight: '600'},
  backupHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  removeLink: {color: colors.danger, fontSize: 13, fontWeight: '500'},
  addBackup: {alignSelf: 'flex-start', paddingVertical: 6},
  addBackupText: {color: colors.ink, fontSize: 13, fontWeight: '600'},
  divider: {height: hairline, backgroundColor: colors.hairline, marginVertical: 4},
  button: {minHeight: 50, borderRadius: radius.md, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  pressed: {opacity: 0.82},
  disabled: {opacity: 0.5},
  buttonText: {color: colors.paper, fontSize: 15, fontWeight: '600'},
  error: {color: colors.danger, fontSize: 13, lineHeight: 19},
  warning: {color: colors.danger, fontSize: 12, lineHeight: 17},
  hint: {color: colors.muted, fontSize: 12, lineHeight: 18},
});
