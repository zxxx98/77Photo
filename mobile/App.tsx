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

const ink = '#3D4A5C';
const muted = '#75808A';

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
        const [lastServer, saved] = await Promise.all([loadLastServer(), loadSession()]);
        if (!active) {return;}
        setServer(saved?.server ?? lastServer);
        if (saved) {await resume(saved);}
      } catch (problem) {
        if (active) {setError(message(problem));}
      } finally {
        if (active) {setBooting(false);}
      }
    })();
    return () => {active = false;};
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

  async function signOut() {
    if (!session || pending) {return;}
    setPending(true);
    setError('');
    try {
      const valid = await restoreSession(session);
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
    return <BrowseApp session={session} onSession={setSession} onSignOut={signOut} error={error} />;
  }

  return <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
    <StatusBar barStyle="dark-content" />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.brand}><Text style={styles.brandText}>77</Text></View>
      <Text style={styles.title}>77Photo</Text>
      <Text style={styles.subtitle}>随时连接家里的照片</Text>
      {booting ? <ActivityIndicator color={ink} /> : <View style={styles.card}>
        <Text style={styles.heading}>连接服务器</Text>
        <Text style={styles.label}>服务器地址</Text>
        <TextInput style={styles.input} value={server} onChangeText={setServer}
          placeholder="https://photos.example.com" autoCapitalize="none" autoCorrect={false}
          keyboardType="url" accessibilityLabel="服务器地址" editable={!pending} />
        {server.trim().toLowerCase().startsWith('http://') ?
          <Text style={styles.warning}>HTTP 连接未加密，账号和照片可能被同一网络中的设备读取。请仅在可信内网使用。</Text> : null}
        {backups.map((value, index) => <View key={index}>
          <TextInput style={styles.input} value={value} onChangeText={text => setBackups(old => old.map((item, i) => i === index ? text : item))}
            placeholder="备用地址，例如 http://100.90.1.10:8080" autoCapitalize="none" autoCorrect={false}
            keyboardType="url" accessibilityLabel={`备用地址 ${index + 1}`} editable={!pending} />
          <Pressable disabled={pending} accessibilityRole="button" style={styles.secondary} onPress={() => setBackups(old => old.filter((_, i) => i !== index))}><Text style={styles.secondaryText}>删除备用地址</Text></Pressable>
          {value.trim().toLowerCase().startsWith('http://') ? <Text style={styles.warning}>HTTP 连接未加密，请仅在可信内网或加密组网中使用。</Text> : null}
        </View>)}
        {backups.length < 7 ? <Pressable disabled={pending} accessibilityRole="button" style={styles.secondary} onPress={() => setBackups(old => [...old, ''])}><Text style={styles.secondaryText}>添加备用地址</Text></Pressable> : null}
        {backups.length ? <Text style={styles.hint}>备用地址验证通过后自动启用；离线地址可登录后在设置中验证。</Text> : null}
        <Text style={styles.label}>账号</Text>
        <TextInput style={styles.input} value={username} onChangeText={setUsername}
          placeholder="用户名" autoCapitalize="none" autoCorrect={false}
          textContentType="username" accessibilityLabel="账号" editable={!pending} />
        <Text style={styles.label}>密码</Text>
        <View style={styles.passwordRow}>
          <TextInput style={styles.passwordInput} value={password} onChangeText={setPassword}
            placeholder="密码" secureTextEntry={!showPassword} textContentType="password"
            accessibilityLabel="密码" editable={!pending} />
          <Pressable style={styles.reveal} accessibilityRole="button" accessibilityLabel={showPassword ? '隐藏密码' : '显示密码'} onPress={() => setShowPassword(!showPassword)}>
            <Text style={styles.secondaryText}>{showPassword ? '隐藏' : '显示'}</Text>
          </Pressable>
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button title={pending ? '正在登录…' : '登录'} disabled={pending} onPress={submitLogin} />
        <Text style={styles.hint}>请使用服务器中的 77Photo 账号登录。</Text>
      </View>}
    </ScrollView>
  </View>;
}

function Button({title, disabled, onPress}: {title: string; disabled: boolean; onPress: () => void}) {
  return <Pressable style={[styles.button, disabled && styles.disabled]} disabled={disabled} onPress={onPress} accessibilityRole="button">
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>;
}

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#FAF9F7'},
  content: {flexGrow: 1, paddingHorizontal: 24, paddingTop: 44, paddingBottom: 32, alignItems: 'center'},
  brand: {width: 64, height: 64, borderRadius: 20, backgroundColor: ink, alignItems: 'center', justifyContent: 'center'},
  brandText: {color: '#FFFFFF', fontSize: 28, fontWeight: '700'},
  title: {color: ink, fontSize: 30, fontWeight: '700', marginTop: 20},
  subtitle: {color: muted, fontSize: 15, marginTop: 6, marginBottom: 36},
  card: {width: '100%', maxWidth: 440, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 24, borderWidth: 1, borderColor: '#E9E5E1'},
  heading: {fontSize: 21, fontWeight: '600', color: ink, marginBottom: 20},
  label: {fontSize: 14, fontWeight: '600', color: ink, marginBottom: 8},
  input: {height: 52, borderWidth: 1, borderColor: '#E9E5E1', borderRadius: 14, paddingHorizontal: 15, fontSize: 16, color: ink, marginBottom: 18},
  passwordRow: {height: 52, borderWidth: 1, borderColor: '#E9E5E1', borderRadius: 14, flexDirection: 'row', alignItems: 'center'},
  passwordInput: {flex: 1, height: 50, paddingHorizontal: 15, fontSize: 16, color: ink},
  reveal: {minWidth: 52, minHeight: 48, justifyContent: 'center', alignItems: 'center'},
  button: {minHeight: 52, borderRadius: 16, backgroundColor: ink, alignItems: 'center', justifyContent: 'center', marginTop: 20},
  disabled: {opacity: 0.55},
  buttonText: {color: '#FFFFFF', fontSize: 16, fontWeight: '600'},
  secondary: {minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  secondaryText: {color: ink, fontSize: 14},
  error: {color: '#A65757', fontSize: 14, marginTop: 12, lineHeight: 20},
  warning: {color: '#A65757', fontSize: 13, marginTop: -8, marginBottom: 16},
  name: {color: ink, fontSize: 18, marginBottom: 5},
  muted: {color: muted, fontSize: 14},
  hint: {color: muted, fontSize: 13, lineHeight: 20, marginTop: 18},
});
