import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const wsErrors = new Counter('ws_errors');
const wsConnections = new Counter('ws_connections');
const wsSuccess = new Rate('ws_success');

export const options = {
  scenarios: {
    ws_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 200 },
        { duration: '1m', target: 200 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    ws_errors: ['count<50'],
  },
  insecureSkipTLSVerify: true,
};

const WS_URL = __ENV.WS_URL || 'wss://pickket-stg-alb-963299864.ap-northeast-2.elb.amazonaws.com';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';

export default function () {
  const url = `${WS_URL}/ws/${EVENT_ID}`;
  const params = {
    headers: {
      'Host': 'api-staging.pickket.kr',
    },
  };

  const res = ws.connect(url, params, function (socket) {
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

    // Hold connection for 30 seconds
    sleep(30);
    socket.close();
  });

  const connected = res && res.status === 101;
  wsSuccess.add(connected ? 1 : 0);
  check(res, { 'ws connected': (r) => r && r.status === 101 });
}
