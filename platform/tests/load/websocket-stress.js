import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const wsErrors = new Counter('ws_errors');
const wsConnections = new Counter('ws_connections');

export const options = {
  scenarios: {
    ws_connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '3m', target: 2000 },
        { duration: '3m', target: 5000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    ws_errors: ['count<100'],
  },
};

const WS_URL = __ENV.WS_URL || 'ws://localhost:8031';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';

export default function () {
  const url = `${WS_URL}/ws/${EVENT_ID}`;

  const res = ws.connect(url, {}, function (socket) {
    wsConnections.add(1);

    socket.on('open', function () {
      socket.send(JSON.stringify({ type: 'subscribe', event_id: EVENT_ID }));
    });

    socket.on('message', function (msg) {
      check(msg, { 'received message': (m) => m.length > 0 });
    });

    socket.on('error', function (e) {
      wsErrors.add(1);
    });

    // Keep connection alive for 2 minutes
    sleep(120);
    socket.close();
  });

  check(res, { 'ws connected': (r) => r && r.status === 101 });
}
