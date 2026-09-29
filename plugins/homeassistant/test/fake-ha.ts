import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

/**
 * A small fake Home Assistant for tests: the WebSocket API at `/api/websocket` (token sign-in,
 * `get_config`, `get_services`, registries, `get_states`, `call_service`, dashboards, event
 * subscriptions) and the REST config endpoints for automations/scripts/scenes, on one port.
 */

export const FAKE_TOKEN = 'fake-ha-long-lived-token-abcdef';

type Json = Record<string, unknown>;

export const SERVICES: Json = {
  light: {
    turn_on: {
      name: 'Turn on',
      description: 'Turns on one or more lights.',
      target: { entity: { domain: 'light' } },
      fields: {
        brightness: { name: 'Brightness', selector: { number: { min: 0, max: 255 } } },
        advanced_fields: {
          collapsed: true,
          fields: { flash: { selector: { select: { options: ['short', 'long'] } } } },
        },
      },
    },
    turn_off: { name: 'Turn off', target: { entity: { domain: 'light' } }, fields: {} },
  },
  switch: { turn_on: { name: 'Turn on', target: { entity: { domain: 'switch' } }, fields: {} } },
  lock: {
    unlock: { name: 'Unlock', target: { entity: { domain: 'lock' } }, fields: { code: { selector: { text: {} } } } },
    lock: { name: 'Lock', target: { entity: { domain: 'lock' } }, fields: {} },
  },
  cover: {
    open_cover: { name: 'Open', target: { entity: { domain: 'cover' } }, fields: {} },
    close_cover: { name: 'Close', target: { entity: { domain: 'cover' } }, fields: {} },
    toggle: { name: 'Toggle', target: { entity: { domain: 'cover' } }, fields: {} },
    set_cover_position: {
      name: 'Set position',
      target: { entity: { domain: 'cover' } },
      fields: { position: { required: true, selector: { number: { min: 0, max: 100 } } } },
    },
  },
  climate: {
    set_temperature: {
      name: 'Set target temperature',
      target: { entity: { domain: 'climate' } },
      fields: {
        temperature: { selector: { number: { min: 7, max: 35 } } },
        hvac_mode: { selector: { select: { options: ['heat', 'cool'] } } },
      },
    },
  },
  alarm_control_panel: {
    alarm_disarm: { name: 'Disarm', target: { entity: { domain: 'alarm_control_panel' } }, fields: {} },
  },
  homeassistant: {
    restart: { name: 'Restart', fields: {} },
    stop: { name: 'Stop', fields: {} },
    turn_on: { name: 'Generic turn on', target: { entity: {} }, fields: {} },
    turn_off: { name: 'Generic turn off', target: { entity: {} }, fields: {} },
    toggle: { name: 'Generic toggle', target: { entity: {} }, fields: {} },
  },
  automation: { trigger: { name: 'Trigger', target: { entity: { domain: 'automation' } }, fields: {} } },
  scene: {
    apply: { name: 'Apply', fields: { entities: { required: true, selector: { object: {} } }, transition: {} } },
    turn_on: { name: 'Activate', target: { entity: { domain: 'scene' } }, fields: {} },
  },
  sonos: {
    snapshot: {
      name: 'Snapshot',
      target: { entity: [{ integration: 'sonos', domain: ['media_player'] }] },
      fields: {},
    },
  },
  weather: {
    get_forecasts: {
      name: 'Get forecasts',
      target: { entity: { domain: 'weather' } },
      fields: {},
      response: { optional: false },
    },
  },
};

const AREAS = [
  { area_id: 'living_room', name: 'Living Room', floor_id: 'ground', labels: [] },
  { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground', labels: [] },
  { area_id: 'garage', name: 'Garage', floor_id: 'ground', labels: ['outdoor'] },
  { area_id: 'attic', name: 'Attic', floor_id: 'top', labels: [] },
];
const FLOORS = [
  { floor_id: 'ground', name: 'Ground floor' },
  { floor_id: 'top', name: 'Top floor' },
];
const DEVICES = [
  { id: 'dev_lamp', name: 'Lamp plug', name_by_user: 'Reading lamp', area_id: 'living_room', labels: [] },
  { id: 'dev_garage', name: 'Garage Door Opener', area_id: 'garage', labels: [] },
];
const LABELS = [{ label_id: 'outdoor', name: 'Outdoor' }];
const ENTITIES = [
  { entity_id: 'light.reading_lamp', device_id: 'dev_lamp', area_id: null, labels: [] },
  { entity_id: 'light.ceiling', device_id: null, area_id: 'living_room', labels: [] },
  { entity_id: 'light.kitchen', device_id: null, area_id: 'kitchen', labels: [] },
  {
    entity_id: 'cover.garage_door',
    device_id: 'dev_garage',
    area_id: null,
    original_device_class: 'garage',
    labels: [],
  },
  { entity_id: 'cover.blinds', device_id: null, area_id: 'living_room', labels: [] },
  { entity_id: 'lock.front_door', device_id: null, area_id: null, labels: [] },
  { entity_id: 'climate.thermostat', device_id: null, area_id: 'living_room', labels: [] },
  { entity_id: 'switch.porch', device_id: null, area_id: null, labels: ['outdoor'] },
  { entity_id: 'weather.home', device_id: null, area_id: null, labels: [] },
  { entity_id: 'media_player.sonos_living', platform: 'sonos', device_id: null, area_id: 'living_room', labels: [] },
  { entity_id: 'media_player.tv', platform: 'cast', device_id: null, area_id: 'living_room', labels: [] },
];
const STATES = [
  ['light.reading_lamp', 'on', { friendly_name: 'Reading Lamp' }],
  ['light.ceiling', 'off', { friendly_name: 'Living Room Ceiling' }],
  ['light.kitchen', 'off', { friendly_name: 'Kitchen Light' }],
  ['cover.garage_door', 'closed', { friendly_name: 'Garage Door' }],
  ['cover.blinds', 'open', { friendly_name: 'Blinds', device_class: 'blind' }],
  ['lock.front_door', 'locked', { friendly_name: 'Front Door' }],
  ['climate.thermostat', 'heat', { friendly_name: 'Thermostat', temperature: 20 }],
  ['switch.porch', 'off', { friendly_name: 'Porch Light' }],
  ['weather.home', 'sunny', { friendly_name: 'Home' }],
  ['media_player.sonos_living', 'idle', { friendly_name: 'Living Room Sonos' }],
  ['media_player.tv', 'off', { friendly_name: 'TV' }],
  ['scene.movie', 'scening', { friendly_name: 'Movie night', entity_id: ['light.ceiling', 'media_player.tv'] }],
  ['scene.leaving', 'scening', { friendly_name: 'Leaving', entity_id: ['light.kitchen', 'lock.front_door'] }],
  [
    'camera.driveway',
    'idle',
    {
      friendly_name: 'Driveway',
      access_token: 'cam-secret-token-123',
      entity_picture: '/api/camera_proxy/camera.driveway?token=cam-secret-token-123',
    },
  ],
  ['sensor.untracked', '21', { friendly_name: 'Untracked Sensor' }],
].map(([entity_id, state, attributes]) => ({ entity_id, state, attributes }));

export interface FakeHa {
  url: string;
  calls: { type: string; payload: Json }[];
  restCalls: { method: string; path: string; body?: unknown }[];
  automations: Map<string, Json>;
  scripts: Map<string, Json>;
  scenes: Map<string, Json>;
  dashboard: { config: Json };
  /** WebSocket command types that answer `unauthorized`. */
  denied: Set<string>;
  /** Sends an event to every subscriber of its type. */
  emit(eventType: string, data?: Json): void;
  /** Moves an entity to another area (as a registry edit in the HA UI would). */
  moveEntity(entityId: string, areaId: string | null): void;
  drop(): void;
  close(): Promise<void>;
}

export async function startFakeHa(): Promise<FakeHa> {
  const calls: FakeHa['calls'] = [];
  const restCalls: FakeHa['restCalls'] = [];
  const denied = new Set<string>();
  const entities = ENTITIES.map((e) => ({ ...e }));
  const automations = new Map<string, Json>([
    [
      'morning',
      {
        id: 'morning',
        alias: 'Morning lights',
        triggers: [{ trigger: 'sun', event: 'sunrise' }],
        actions: [{ action: 'light.turn_on', target: { area_id: 'kitchen' } }],
        mode: 'single',
      },
    ],
  ]);
  const scripts = new Map<string, Json>([['bedtime', { alias: 'Bedtime', sequence: [] }]]);
  const scenes = new Map<string, Json>();
  const dashboard = { config: { title: 'Home', views: [{ title: 'Main', cards: [] }] } as Json };
  const subscribers = new Map<WebSocket, Map<number, string>>();

  const command = (msg: Json): unknown => {
    const type = String(msg.type);
    const { id: _id, type: _t, ...payload } = msg;
    calls.push({ type, payload });
    if (denied.has(type)) throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' });
    switch (type) {
      case 'get_config':
        return { version: '2026.9.1', location_name: 'Home Sweet Home', unit_system: { temperature: '°C' } };
      case 'get_services':
        return SERVICES;
      case 'get_states':
        return STATES;
      case 'config/area_registry/list':
        return AREAS;
      case 'config/floor_registry/list':
        return FLOORS;
      case 'config/device_registry/list':
        return DEVICES;
      case 'config/entity_registry/list':
        return entities;
      case 'config/label_registry/list':
        return LABELS;
      case 'call_service': {
        if (!SERVICES[String(payload.domain)] || !(SERVICES[String(payload.domain)] as Json)[String(payload.service)])
          throw Object.assign(new Error(`Service ${String(payload.domain)}.${String(payload.service)} not found.`), {
            code: 'not_found',
          });
        if (payload.domain === 'climate' && ((payload.service_data as Json)?.temperature as number) > 35)
          throw Object.assign(new Error('Temperature out of range'), { code: 'service_validation_error' });
        if (payload.return_response) return { context: { id: 'c1' }, response: { 'weather.home': { forecast: [] } } };
        return { context: { id: 'c1' } };
      }
      case 'lovelace/config':
        return dashboard.config;
      case 'lovelace/config/save':
        dashboard.config = payload.config as Json;
        return null;
      case 'config/area_registry/delete':
        return 'success';
      case 'history/history_during_period':
        return { 'light.kitchen': [{ s: 'off', lu: 1 }] };
      default:
        throw Object.assign(new Error('Unknown command.'), { code: 'unknown_command' });
    }
  };

  const configStores: Record<string, Map<string, Json>> = { automation: automations, script: scripts, scene: scenes };

  const rest = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(401, { message: 'Unauthorized' });
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    const url = new URL(req.url ?? '/', 'http://fake');
    restCalls.push({ method: req.method ?? 'GET', path: url.pathname, ...(body !== undefined ? { body } : {}) });
    const m = /^\/api\/config\/(automation|script|scene)\/config\/([^/]+)$/.exec(url.pathname);
    if (!m) return send(404, { message: 'Not found' });
    const store = configStores[m[1]!]!;
    const id = decodeURIComponent(m[2]!);
    if (req.method === 'GET')
      return store.has(id) ? send(200, store.get(id)) : send(404, { message: 'Resource not found' });
    if (req.method === 'POST') {
      store.set(id, body as Json);
      return send(200, { result: 'ok' });
    }
    if (req.method === 'DELETE') {
      if (!store.delete(id)) return send(404, { message: 'Resource not found' });
      return send(200, { result: 'ok' });
    }
    return send(405, { message: 'Method not allowed' });
  };

  const server = createServer((req, res) => void rest(req, res));
  const wss = new WebSocketServer({ server, path: '/api/websocket' });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    subscribers.set(ws, new Map());
    ws.on('close', () => {
      sockets.delete(ws);
      subscribers.delete(ws);
    });
    let authed = false;
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.9.1' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Json;
      if (!authed) {
        if (msg.type === 'auth' && msg.access_token === FAKE_TOKEN) {
          authed = true;
          ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.1' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' }));
          ws.close();
        }
        return;
      }
      const id = msg.id as number;
      if (msg.type === 'subscribe_events') {
        subscribers.get(ws)!.set(id, String(msg.event_type));
        ws.send(JSON.stringify({ id, type: 'result', success: true, result: null }));
        return;
      }
      try {
        ws.send(JSON.stringify({ id, type: 'result', success: true, result: command(msg) }));
      } catch (err) {
        const e = err as Error & { code?: string };
        ws.send(
          JSON.stringify({
            id,
            type: 'result',
            success: false,
            error: { code: e.code ?? 'unknown_error', message: e.message },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    restCalls,
    automations,
    scripts,
    scenes,
    dashboard,
    denied,
    emit(eventType, data = {}) {
      for (const [ws, subs] of subscribers) {
        for (const [id, type] of subs) {
          if (type === eventType)
            ws.send(JSON.stringify({ id, type: 'event', event: { event_type: eventType, data } }));
        }
      }
    },
    moveEntity(entityId, areaId) {
      const e = entities.find((x) => x.entity_id === entityId);
      if (e) e.area_id = areaId;
    },
    drop() {
      for (const s of sockets) s.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
