import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator,
  SafeAreaView, StatusBar, Animated, Dimensions, Alert,
  ScrollView, Modal,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import Constants from 'expo-constants';

WebBrowser.maybeCompleteAuthSession();

const { width: W } = Dimensions.get('window');

// ─── Config (from app.config.js extra, injected via .env) ──────────────────
const {
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
  claudeKey: CLAUDE_KEY,
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: GOOGLE_CLIENT_SECRET,
  googleDevToken: GOOGLE_DEV_TOKEN,
  mccCustomerId: MCC_CUSTOMER_ID,
} = Constants.expoConfig?.extra ?? {};

const REDIRECT_URI = 'adsbrain://oauth';

const SECURE_KEYS = {
  GOOGLE_ACCESS: 'google_access_token',
  GOOGLE_REFRESH: 'google_refresh_token',
  GOOGLE_EXPIRY: 'google_token_expiry',
  ACTIVE_ACCOUNT: 'active_account_id',
};

// ─── Colors ─────────────────────────────────────────────────────────────────
const C = {
  bg: '#09090F', surface: '#13131C', border: 'rgba(255,255,255,0.07)',
  violet: '#7C3AED', violetL: '#8B5CF6', white: '#FFF',
  w70: 'rgba(255,255,255,0.70)', w40: 'rgba(255,255,255,0.40)',
  w20: 'rgba(255,255,255,0.20)', w10: 'rgba(255,255,255,0.10)',
  w05: 'rgba(255,255,255,0.05)', green: '#10B981', red: '#EF4444',
  orange: '#F59E0B',
};

const SYSTEM_PROMPT = `Sos AdsBrain AI, agente experto en Google Ads y marketing digital.
Hablás en español latinoamericano. Sos directo y profesional.
Nunca uses asteriscos ni almohadillas. Sin markdown.
Usá guiones para listas y emojis para secciones.
Respuestas cortas y accionables.
Cuando recibas datos reales de campañas, analízalos y da recomendaciones concretas.`;

const QUICK = [
  { label: '📊 Ver campañas', prompt: 'Mostrá mis campañas activas con métricas' },
  { label: '📈 Rendimiento', prompt: 'Analizá el rendimiento de mi cuenta este mes' },
  { label: '💡 Recomendaciones', prompt: 'Dame recomendaciones para mejorar mis campañas' },
  { label: '⏸️ Pausar campaña', prompt: '¿Cómo pauso una campaña con bajo rendimiento?' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function cleanText(t) {
  return t
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(micros) {
  if (micros == null) return '—';
  return '$' + (micros / 1_000_000).toFixed(2);
}

// ─── Supabase ────────────────────────────────────────────────────────────────
async function supaFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...options,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function signUp(email, password) {
  return supaFetch('/auth/v1/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

async function signIn(email, password) {
  return supaFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

async function saveConnectedAccount(userId, token, accountData) {
  return supaFetch('/rest/v1/cuentas_conectadas', {
    method: 'POST',
    token,
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      platform: 'google_ads',
      account_name: accountData.descriptiveName || accountData.id,
      account_id: accountData.id,
      currency_code: accountData.currencyCode || 'USD',
      is_mcc: accountData.isMcc || false,
    }),
  });
}

async function getConnectedAccounts(userId, token) {
  return supaFetch(
    `/rest/v1/cuentas_conectadas?user_id=eq.${userId}&platform=eq.google_ads&select=*`,
    { token }
  );
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────
function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }).toString(),
  });
  return res.json();
}

async function saveGoogleTokens(accessToken, refreshToken, expiresIn) {
  const expiry = Date.now() + (expiresIn - 60) * 1000;
  await SecureStore.setItemAsync(SECURE_KEYS.GOOGLE_ACCESS, accessToken);
  if (refreshToken) await SecureStore.setItemAsync(SECURE_KEYS.GOOGLE_REFRESH, refreshToken);
  await SecureStore.setItemAsync(SECURE_KEYS.GOOGLE_EXPIRY, String(expiry));
}

async function getValidAccessToken() {
  const expiry = await SecureStore.getItemAsync(SECURE_KEYS.GOOGLE_EXPIRY);
  const access = await SecureStore.getItemAsync(SECURE_KEYS.GOOGLE_ACCESS);
  const refresh = await SecureStore.getItemAsync(SECURE_KEYS.GOOGLE_REFRESH);
  if (!access || !refresh) return null;
  if (expiry && Date.now() < Number(expiry)) return access;
  const data = await refreshAccessToken(refresh);
  if (data.access_token) {
    await saveGoogleTokens(data.access_token, data.refresh_token || refresh, data.expires_in || 3600);
    return data.access_token;
  }
  return null;
}

// ─── Google Ads API ──────────────────────────────────────────────────────────
async function gadsRequest(path, body, accessToken, customerId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEV_TOKEN,
    'Content-Type': 'application/json',
  };
  if (customerId) headers['login-customer-id'] = MCC_CUSTOMER_ID;

  const res = await fetch(`https://googleads.googleapis.com/v17/${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function listChildAccounts(accessToken) {
  const data = await gadsRequest(
    `customers/${MCC_CUSTOMER_ID}/googleAds:searchStream`,
    {
      query: `SELECT customer_client.client_customer, customer_client.descriptive_name,
              customer_client.currency_code, customer_client.manager
              FROM customer_client WHERE customer_client.level = 1`,
    },
    accessToken,
    MCC_CUSTOMER_ID
  );
  if (data.error) throw new Error(data.error.message || 'Error al listar cuentas');
  const clients = [];
  (data || []).forEach(r => {
    (r.results || []).forEach(row => {
      const c = row.customerClient;
      if (c) clients.push({
        id: c.clientCustomer?.replace('customers/', ''),
        descriptiveName: c.descriptiveName || c.clientCustomer,
        currencyCode: c.currencyCode,
        isMcc: c.manager || false,
      });
    });
  });
  return clients;
}

async function listCampaigns(accessToken, customerId) {
  const data = await gadsRequest(
    `customers/${customerId}/googleAds:searchStream`,
    {
      query: `SELECT campaign.id, campaign.name, campaign.status,
              metrics.impressions, metrics.clicks, metrics.cost_micros,
              metrics.conversions, metrics.ctr
              FROM campaign
              WHERE segments.date DURING LAST_30_DAYS
              ORDER BY metrics.cost_micros DESC`,
    },
    accessToken,
    customerId
  );
  if (data.error) throw new Error(data.error.message || 'Error al listar campañas');
  const campaigns = [];
  (data || []).forEach(r => {
    (r.results || []).forEach(row => {
      if (row.campaign) campaigns.push({
        id: row.campaign.id,
        name: row.campaign.name,
        status: row.campaign.status,
        impressions: row.metrics?.impressions || 0,
        clicks: row.metrics?.clicks || 0,
        costMicros: row.metrics?.costMicros || 0,
        conversions: row.metrics?.conversions || 0,
        ctr: row.metrics?.ctr || 0,
      });
    });
  });
  return campaigns;
}

async function mutateCampaignStatus(accessToken, customerId, campaignId, status) {
  return gadsRequest(
    `customers/${customerId}/campaigns:mutate`,
    {
      operations: [{
        update: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, status },
        updateMask: 'status',
      }],
    },
    accessToken,
    customerId
  );
}

// ─── Claude ──────────────────────────────────────────────────────────────────
async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return cleanText(data.content[0].text);
}

// ─── AuthScreen ──────────────────────────────────────────────────────────────
function AuthScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [mode, setMode] = useState('login');
  const [loading, setLoading] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, []);

  async function handleSubmit() {
    if (!email.trim() || !pass.trim()) {
      Alert.alert('Campos requeridos', 'Completá email y contraseña.');
      return;
    }
    setLoading(true);
    try {
      let data;
      if (mode === 'login') {
        data = await signIn(email.trim(), pass);
      } else {
        data = await signUp(email.trim(), pass);
        if (!data.error) {
          Alert.alert('¡Cuenta creada!', 'Revisá tu email para confirmar.');
          setMode('login');
          setLoading(false);
          return;
        }
      }
      if (data.error) throw new Error(data.error.message || data.msg || 'Error de autenticación');
      onLogin(data);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'center', padding: 24 }}
      >
        <Animated.View style={{ opacity: fadeAnim }}>
          <Text style={{ fontSize: 32, fontWeight: '800', color: C.white, textAlign: 'center', letterSpacing: -1 }}>
            Ads<Text style={{ color: C.violetL }}>Brain</Text> AI
          </Text>
          <Text style={{ color: C.w40, textAlign: 'center', marginTop: 6, marginBottom: 40 }}>
            Marketing digital con inteligencia artificial
          </Text>

          <View style={styles.inputWrap}>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={C.w40}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View style={[styles.inputWrap, { marginTop: 12 }]}>
            <TextInput
              style={styles.input}
              placeholder="Contraseña"
              placeholderTextColor={C.w40}
              value={pass}
              onChangeText={setPass}
              secureTextEntry
            />
          </View>

          <TouchableOpacity
            style={[styles.btn, { marginTop: 24, opacity: loading ? 0.7 : 1 }]}
            onPress={handleSubmit}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={C.white} />
              : <Text style={styles.btnText}>{mode === 'login' ? 'Ingresar' : 'Crear cuenta'}</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 16, alignItems: 'center' }}
            onPress={() => setMode(m => m === 'login' ? 'signup' : 'login')}
          >
            <Text style={{ color: C.violetL }}>
              {mode === 'login' ? '¿No tenés cuenta? Registrarte' : '¿Ya tenés cuenta? Ingresar'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── OnboardingScreen ────────────────────────────────────────────────────────
function OnboardingScreen({ session, onComplete }) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [mccInput, setMccInput] = useState('');
  const [childAccounts, setChildAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: (step - 1) / 2,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [step]);

  async function handleGoogleOAuth() {
    setLoading(true);
    try {
      const authUrl = buildAuthUrl();
      const result = await WebBrowser.openAuthSessionAsync(authUrl, REDIRECT_URI);

      if (result.type !== 'success') {
        setLoading(false);
        return;
      }

      const url = result.url;
      const code = url.match(/[?&]code=([^&]+)/)?.[1];
      if (!code) throw new Error('No se recibió código de autorización');

      const tokens = await exchangeCodeForTokens(decodeURIComponent(code));
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      await saveGoogleTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in || 3600);
      setStep(2);
    } catch (e) {
      Alert.alert('Error OAuth', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleMccSubmit() {
    setLoading(true);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('No hay token de Google válido');
      const accounts = await listChildAccounts(token);
      setChildAccounts(accounts);
      setStep(3);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectAccount(account) {
    setSelectedAccount(account);
    setLoading(true);
    try {
      const userId = session.user?.id;
      const token = session.access_token;
      await saveConnectedAccount(userId, token, account);
      await SecureStore.setItemAsync(SECURE_KEYS.ACTIVE_ACCOUNT, account.id);
      onComplete(account);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" />

      {/* Progress bar */}
      <View style={{ height: 3, backgroundColor: C.w10, marginTop: 8 }}>
        <Animated.View style={{
          height: 3, backgroundColor: C.violet,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['33%', '100%'] }),
        }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 24, flexGrow: 1 }}>
        <Text style={{ color: C.w40, fontSize: 13, marginBottom: 4 }}>
          Paso {step} de 3
        </Text>

        {/* Paso 1 – OAuth */}
        {step === 1 && (
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Conectá Google Ads</Text>
            <Text style={{ color: C.w40, marginTop: 8, lineHeight: 22 }}>
              Necesitamos acceso a tu cuenta de Google Ads para mostrar campañas y métricas reales.
            </Text>

            <View style={[styles.card, { marginTop: 32 }]}>
              <Text style={{ fontSize: 40, textAlign: 'center' }}>🔐</Text>
              <Text style={{ color: C.w70, textAlign: 'center', marginTop: 12 }}>
                Se abrirá el navegador para que autorices el acceso a Google Ads.
                Tus credenciales se guardan de forma segura en el dispositivo.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.btn, { marginTop: 32, opacity: loading ? 0.7 : 1 }]}
              onPress={handleGoogleOAuth}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color={C.white} />
                : <Text style={styles.btnText}>🔗 Conectar con Google</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Paso 2 – MCC ID */}
        {step === 2 && (
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>ID de cuenta MCC</Text>
            <Text style={{ color: C.w40, marginTop: 8, lineHeight: 22 }}>
              Ingresá el ID de tu cuenta administradora (MCC) de Google Ads.
            </Text>

            <View style={[styles.inputWrap, { marginTop: 32 }]}>
              <TextInput
                style={styles.input}
                placeholder="Ej: 560-663-9886"
                placeholderTextColor={C.w40}
                value={mccInput || '560-663-9886'}
                onChangeText={setMccInput}
                keyboardType="numeric"
              />
            </View>

            <Text style={{ color: C.w40, fontSize: 12, marginTop: 8 }}>
              Lo encontrás en la esquina superior de Google Ads Manager.
            </Text>

            <TouchableOpacity
              style={[styles.btn, { marginTop: 32, opacity: loading ? 0.7 : 1 }]}
              onPress={handleMccSubmit}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color={C.white} />
                : <Text style={styles.btnText}>Buscar cuentas →</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Paso 3 – Seleccionar cuenta */}
        {step === 3 && (
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Elegí tu cuenta</Text>
            <Text style={{ color: C.w40, marginTop: 8, marginBottom: 24 }}>
              {childAccounts.length > 0
                ? `${childAccounts.length} cuentas encontradas`
                : 'No se encontraron cuentas hijo. Verificá el MCC ID.'
              }
            </Text>

            {childAccounts.length === 0 && (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: C.surface, marginBottom: 16 }]}
                onPress={() => setStep(2)}
              >
                <Text style={[styles.btnText, { color: C.violetL }]}>← Volver</Text>
              </TouchableOpacity>
            )}

            {childAccounts.map(account => (
              <TouchableOpacity
                key={account.id}
                style={[styles.card, {
                  marginBottom: 12,
                  borderColor: selectedAccount?.id === account.id ? C.violet : C.border,
                  borderWidth: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }]}
                onPress={() => handleSelectAccount(account)}
                disabled={loading}
              >
                <View>
                  <Text style={{ color: C.white, fontWeight: '600' }}>
                    {account.descriptiveName}
                  </Text>
                  <Text style={{ color: C.w40, fontSize: 12, marginTop: 2 }}>
                    ID: {account.id} · {account.currencyCode}
                  </Text>
                </View>
                {loading && selectedAccount?.id === account.id
                  ? <ActivityIndicator color={C.violet} size="small" />
                  : <Text style={{ color: C.violetL }}>Seleccionar →</Text>
                }
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── CampaignTable ────────────────────────────────────────────────────────────
function CampaignTable({ campaigns, onMutate }) {
  const statusColor = s => s === 'ENABLED' ? C.green : s === 'PAUSED' ? C.orange : C.w40;
  const statusLabel = s => s === 'ENABLED' ? '▶ Activa' : s === 'PAUSED' ? '⏸ Pausada' : s;

  function confirmMutate(campaign) {
    const action = campaign.status === 'ENABLED' ? 'pausar' : 'reactivar';
    const newStatus = campaign.status === 'ENABLED' ? 'PAUSED' : 'ENABLED';
    Alert.alert(
      `¿${action.charAt(0).toUpperCase() + action.slice(1)} campaña?`,
      `"${campaign.name}" va a ser ${action === 'pausar' ? 'pausada' : 'reactivada'}.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', style: action === 'pausar' ? 'destructive' : 'default', onPress: () => onMutate(campaign, newStatus) },
      ]
    );
  }

  if (!campaigns?.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }}>
      <View>
        {/* Header */}
        <View style={[styles.tableRow, { borderBottomColor: C.violet, borderBottomWidth: 1 }]}>
          {['Campaña', 'Estado', 'Impr.', 'Clicks', 'CTR', 'Costo', 'Conv.'].map(h => (
            <Text key={h} style={[styles.tableCell, { color: C.violetL, fontWeight: '700', fontSize: 11 }]}>
              {h}
            </Text>
          ))}
          <Text style={[styles.tableCell, { color: C.violetL, fontWeight: '700', fontSize: 11, width: 70 }]}>
            Acción
          </Text>
        </View>

        {campaigns.map(c => (
          <View key={c.id} style={[styles.tableRow, { borderBottomColor: C.border, borderBottomWidth: 1 }]}>
            <Text style={[styles.tableCell, { color: C.white, width: 120 }]} numberOfLines={1}>
              {c.name}
            </Text>
            <Text style={[styles.tableCell, { color: statusColor(c.status), width: 80 }]}>
              {statusLabel(c.status)}
            </Text>
            <Text style={[styles.tableCell, { color: C.w70 }]}>{fmt(c.impressions)}</Text>
            <Text style={[styles.tableCell, { color: C.w70 }]}>{fmt(c.clicks)}</Text>
            <Text style={[styles.tableCell, { color: C.w70 }]}>{(c.ctr * 100).toFixed(2)}%</Text>
            <Text style={[styles.tableCell, { color: C.w70 }]}>{fmtCost(c.costMicros)}</Text>
            <Text style={[styles.tableCell, { color: C.w70 }]}>{c.conversions?.toFixed(1) || '0'}</Text>
            <TouchableOpacity
              style={{ width: 70, justifyContent: 'center', paddingVertical: 8 }}
              onPress={() => confirmMutate(c)}
            >
              <Text style={{ color: c.status === 'ENABLED' ? C.orange : C.green, fontSize: 11 }}>
                {c.status === 'ENABLED' ? '⏸ Pausar' : '▶ Activar'}
              </Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ─── AccountSelector Modal ───────────────────────────────────────────────────
function AccountSelectorModal({ visible, accounts, activeId, onSelect, onClose, onAddAccount }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)' }}
        activeOpacity={1}
        onPress={onClose}
      />
      <View style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
        padding: 24, paddingBottom: 40,
      }}>
        <Text style={{ color: C.white, fontWeight: '700', fontSize: 18, marginBottom: 16 }}>
          Cambiar cuenta
        </Text>
        {accounts.map(a => (
          <TouchableOpacity
            key={a.account_id || a.id}
            style={[styles.card, {
              marginBottom: 10,
              borderColor: (a.account_id || a.id) === activeId ? C.violet : C.border,
              borderWidth: 1,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            }]}
            onPress={() => onSelect(a)}
          >
            <View>
              <Text style={{ color: C.white, fontWeight: '600' }}>{a.account_name || a.descriptiveName}</Text>
              <Text style={{ color: C.w40, fontSize: 12 }}>ID: {a.account_id || a.id}</Text>
            </View>
            {(a.account_id || a.id) === activeId && <Text style={{ color: C.violetL }}>✓ Activa</Text>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.btn, { backgroundColor: C.w05, marginTop: 8 }]} onPress={onAddAccount}>
          <Text style={[styles.btnText, { color: C.violetL }]}>+ Agregar cuenta</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

// ─── ChatScreen ──────────────────────────────────────────────────────────────
function ChatScreen({ session, activeAccount, allAccounts, onLogout, onChangeAccount, onAddAccount }) {
  const [msgs, setMsgs] = useState([
    {
      id: '0', role: 'assistant',
      content: `¡Hola! Soy AdsBrain AI 🧠\n\nEstoy conectado a tu cuenta "${activeAccount?.descriptiveName || activeAccount?.account_name || 'Google Ads'}". Podés preguntarme sobre campañas, métricas y estrategias.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [mutatingId, setMutatingId] = useState(null);
  const listRef = useRef(null);

  const accountId = activeAccount?.id || activeAccount?.account_id;

  function addMsg(role, content, extra = {}) {
    const msg = { id: Date.now().toString() + Math.random(), role, content, ...extra };
    setMsgs(prev => [...prev, msg]);
    return msg;
  }

  async function handleCampaigns(userMsg) {
    addMsg('user', userMsg);
    setLoading(true);
    try {
      addMsg('assistant', 'Obteniendo datos reales de Google Ads...', { loading: true });
      const token = await getValidAccessToken();
      if (!token) throw new Error('Token de Google expirado. Reconectá tu cuenta.');
      const data = await listCampaigns(token, accountId);
      setCampaigns(data);

      const summary = data.map(c =>
        `- ${c.name}: ${statusLabel(c.status)}, ${fmt(c.impressions)} imp, ${fmt(c.clicks)} clicks, ${fmtCost(c.costMicros)}, CTR ${(c.ctr * 100).toFixed(2)}%`
      ).join('\n');

      const history = msgs
        .filter(m => !m.loading)
        .map(m => ({ role: m.role, content: m.content }));

      history.push({ role: 'user', content: `${userMsg}\n\nDatos reales de campañas (últimos 30 días):\n${summary || 'Sin campañas disponibles.'}` });

      const reply = await callClaude(history);

      setMsgs(prev => {
        const without = prev.filter(m => !m.loading);
        return [...without, { id: Date.now().toString(), role: 'assistant', content: reply, campaigns: data }];
      });
    } catch (e) {
      setMsgs(prev => prev.filter(m => !m.loading));
      addMsg('assistant', `Error al obtener campañas: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleMutate(campaign, newStatus) {
    setMutatingId(campaign.id);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Token de Google expirado');
      await mutateCampaignStatus(token, accountId, campaign.id, newStatus);
      const label = newStatus === 'PAUSED' ? 'pausada' : 'reactivada';
      addMsg('assistant', `✅ Campaña "${campaign.name}" ${label} correctamente.`);
      setCampaigns(prev => prev.map(c => c.id === campaign.id ? { ...c, status: newStatus } : c));
    } catch (e) {
      addMsg('assistant', `Error al modificar campaña: ${e.message}`);
    } finally {
      setMutatingId(null);
    }
  }

  async function handleSend(text) {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput('');

    const lower = msg.toLowerCase();
    const isCampaignQuery = lower.includes('campaña') || lower.includes('campaña') ||
      lower.includes('rendimiento') || lower.includes('métricas') ||
      lower.includes('activas') || lower.includes('recomendaciones') ||
      lower.includes('ver') && lower.includes('campa');

    if (isCampaignQuery) {
      await handleCampaigns(msg);
      return;
    }

    addMsg('user', msg);
    setLoading(true);
    try {
      const history = msgs
        .filter(m => !m.loading)
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));
      history.push({ role: 'user', content: msg });
      const reply = await callClaude(history);
      addMsg('assistant', reply);
    } catch (e) {
      addMsg('assistant', `Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  }, [msgs]);

  function statusLabel(s) {
    return s === 'ENABLED' ? 'Activa' : s === 'PAUSED' ? 'Pausada' : s;
  }

  function renderMsg({ item }) {
    const isUser = item.role === 'user';
    if (item.loading) {
      return (
        <View style={[styles.bubble, styles.bubbleAI]}>
          <ActivityIndicator color={C.violetL} size="small" />
        </View>
      );
    }
    return (
      <View style={{ alignItems: isUser ? 'flex-end' : 'flex-start', marginVertical: 4 }}>
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
          <Text style={{ color: isUser ? C.white : C.w70, lineHeight: 22 }}>{item.content}</Text>
        </View>
        {item.campaigns?.length > 0 && (
          <View style={{ width: '100%', marginTop: 8 }}>
            <CampaignTable campaigns={item.campaigns} onMutate={handleMutate} />
          </View>
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <View>
          <Text style={{ color: C.white, fontWeight: '700', fontSize: 16 }}>AdsBrain AI</Text>
          <TouchableOpacity onPress={() => setShowAccounts(true)}>
            <Text style={{ color: C.violetL, fontSize: 12 }} numberOfLines={1}>
              {activeAccount?.descriptiveName || activeAccount?.account_name || 'Sin cuenta'} ▼
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => Alert.alert('Cerrar sesión', '¿Querés salir?', [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Salir', style: 'destructive', onPress: onLogout },
          ])}
          style={{ padding: 8 }}
        >
          <Text style={{ color: C.w40 }}>Salir</Text>
        </TouchableOpacity>
      </View>

      {/* Quick actions */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
        {QUICK.map(q => (
          <TouchableOpacity
            key={q.label}
            style={styles.chip}
            onPress={() => handleSend(q.prompt)}
            disabled={loading}
          >
            <Text style={{ color: C.white, fontSize: 12 }}>{q.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={msgs}
        keyExtractor={m => m.id}
        renderItem={renderMsg}
        contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Input */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{
          flexDirection: 'row', alignItems: 'flex-end',
          padding: 12, borderTopWidth: 1, borderTopColor: C.border, gap: 10,
        }}>
          <TextInput
            style={[styles.input, { flex: 1, maxHeight: 100, minHeight: 44 }]}
            placeholder="Preguntá sobre tus campañas..."
            placeholderTextColor={C.w40}
            value={input}
            onChangeText={setInput}
            multiline
            onSubmitEditing={() => handleSend()}
          />
          <TouchableOpacity
            style={[styles.btn, {
              width: 44, height: 44, borderRadius: 22,
              paddingHorizontal: 0, alignItems: 'center', justifyContent: 'center',
              opacity: (!input.trim() || loading) ? 0.5 : 1,
            }]}
            onPress={() => handleSend()}
            disabled={!input.trim() || loading}
          >
            {loading
              ? <ActivityIndicator color={C.white} size="small" />
              : <Text style={{ color: C.white, fontSize: 18 }}>↑</Text>
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <AccountSelectorModal
        visible={showAccounts}
        accounts={allAccounts}
        activeId={accountId}
        onSelect={a => { setShowAccounts(false); onChangeAccount(a); }}
        onClose={() => setShowAccounts(false)}
        onAddAccount={() => { setShowAccounts(false); onAddAccount(); }}
      />
    </SafeAreaView>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [activeAccount, setActiveAccount] = useState(null);
  const [allAccounts, setAllAccounts] = useState([]);
  const [onboarding, setOnboarding] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const savedAccountId = await SecureStore.getItemAsync(SECURE_KEYS.ACTIVE_ACCOUNT);
        if (savedAccountId) {
          setActiveAccount({ id: savedAccountId, account_id: savedAccountId, descriptiveName: 'Cuenta guardada' });
        }
      } catch {}
      setChecking(false);
    }
    init();
  }, []);

  useEffect(() => {
    if (!session) return;
    async function loadAccounts() {
      try {
        const data = await getConnectedAccounts(session.user?.id, session.access_token);
        if (Array.isArray(data) && data.length > 0) {
          setAllAccounts(data);
          if (!activeAccount) setActiveAccount(data[0]);
        } else {
          setOnboarding(true);
        }
      } catch {
        setOnboarding(true);
      }
    }
    loadAccounts();
  }, [session]);

  if (checking) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={C.violet} size="large" />
      </SafeAreaView>
    );
  }

  if (!session) return <AuthScreen onLogin={setSession} />;

  if (onboarding || !activeAccount) {
    return (
      <OnboardingScreen
        session={session}
        onComplete={account => {
          setActiveAccount(account);
          setAllAccounts(prev => {
            const exists = prev.find(a => (a.account_id || a.id) === (account.account_id || account.id));
            return exists ? prev : [...prev, account];
          });
          setOnboarding(false);
        }}
      />
    );
  }

  return (
    <ChatScreen
      session={session}
      activeAccount={activeAccount}
      allAccounts={allAccounts}
      onLogout={async () => {
        await SecureStore.deleteItemAsync(SECURE_KEYS.GOOGLE_ACCESS).catch(() => {});
        await SecureStore.deleteItemAsync(SECURE_KEYS.GOOGLE_REFRESH).catch(() => {});
        await SecureStore.deleteItemAsync(SECURE_KEYS.ACTIVE_ACCOUNT).catch(() => {});
        setSession(null);
        setActiveAccount(null);
        setAllAccounts([]);
        setOnboarding(false);
      }}
      onChangeAccount={account => {
        setActiveAccount(account);
        SecureStore.setItemAsync(SECURE_KEYS.ACTIVE_ACCOUNT, account.account_id || account.id).catch(() => {});
      }}
      onAddAccount={() => setOnboarding(true)}
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  btn: {
    backgroundColor: C.violet,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: C.white,
    fontWeight: '700',
    fontSize: 15,
  },
  input: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: C.white,
    fontSize: 15,
  },
  inputWrap: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  card: {
    backgroundColor: C.w05,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: C.white,
    letterSpacing: -0.5,
  },
  bubble: {
    maxWidth: W * 0.8,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bubbleUser: {
    backgroundColor: C.violet,
    borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: C.surface,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 60,
    alignItems: 'flex-start',
  },
  chip: {
    backgroundColor: C.w10,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
  },
  tableCell: {
    width: 75,
    color: C.w70,
    fontSize: 12,
    paddingHorizontal: 4,
  },
};
