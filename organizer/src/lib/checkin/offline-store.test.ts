import { beforeEach, describe, expect, it, vi } from "vitest";

// §13 오프라인 명단 캐시 + 큐 — 모의 IndexedDB(자체 인메모리 구현)로 검증.
// fake-indexeddb 의존 없이 offline-store 가 쓰는 API 표면만 충실히 구현한다.
// (open/onupgradeneeded, objectStore keyPath, index getAll/openCursor, put/get/getAll/delete,
//  IDBKeyRange.only, tx oncomplete/onerror)

interface FakeIndex {
  keyPath: string;
}

class FakeCursor {
  constructor(
    private readonly rows: Record<string, unknown>[],
    private idx: number,
    private readonly onDelete: (row: Record<string, unknown>) => void,
    public readonly reqOnSuccess: () => void,
  ) {}
  get result(): FakeCursor | null {
    return this.idx < this.rows.length ? this : null;
  }
  delete() {
    this.onDelete(this.rows[this.idx]);
  }
  continue() {
    this.idx += 1;
    // 다음 tick 에 onsuccess 재호출(브라우저 커서 세만틱 근사).
    queueMicrotask(() => this.reqOnSuccess());
  }
}

function makeRequest<T>(getValue: () => T) {
  const req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    req.result = getValue();
    req.onsuccess?.();
  });
  return req;
}

class FakeObjectStore {
  constructor(
    public readonly keyPath: string,
    public readonly data: Map<string, Record<string, unknown>>,
    public readonly indexes: Map<string, FakeIndex>,
    private readonly tx: FakeTransaction,
  ) {}

  createIndex(name: string, keyPath: string) {
    this.indexes.set(name, { keyPath });
  }

  put(value: Record<string, unknown>) {
    const key = String(value[this.keyPath]);
    this.data.set(key, value);
    this.tx.pending += 1;
    queueMicrotask(() => this.tx.settle());
  }

  get(key: string) {
    return makeRequest(() => this.data.get(key));
  }

  getAll() {
    return makeRequest(() => Array.from(this.data.values()));
  }

  delete(key: string) {
    this.data.delete(key);
    this.tx.pending += 1;
    queueMicrotask(() => this.tx.settle());
  }

  index(name: string) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`no index ${name}`);
    const filterByRange = (range: { only: unknown } | undefined) =>
      Array.from(this.data.values()).filter((row) => !range || row[idx.keyPath] === range.only);
    return {
      getAll: (range?: { only: unknown }) => makeRequest(() => filterByRange(range)),
      openCursor: (range?: { only: unknown }) => {
        const rows = filterByRange(range);
        const req: { result?: FakeCursor | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
          onsuccess: null,
          onerror: null,
        };
        const cursor = new FakeCursor(
          rows,
          0,
          (row) => {
            this.data.delete(String(row[this.keyPath]));
          },
          () => {
            req.result = cursor.result;
            req.onsuccess?.();
          },
        );
        queueMicrotask(() => {
          req.result = cursor.result;
          req.onsuccess?.();
        });
        return req;
      },
    };
  }
}

class FakeTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public pending = 0;
  private done = false;
  constructor(private readonly db: FakeDb, private readonly storeName: string) {}
  objectStore() {
    return new FakeObjectStore(
      this.db.keyPaths.get(this.storeName)!,
      this.db.stores.get(this.storeName)!,
      this.db.storeIndexes.get(this.storeName)!,
      this,
    );
  }
  settle() {
    this.pending -= 1;
    if (this.pending <= 0 && !this.done) {
      this.done = true;
      this.oncomplete?.();
    }
  }
}

class FakeDb {
  public stores = new Map<string, Map<string, Record<string, unknown>>>();
  public keyPaths = new Map<string, string>();
  public storeIndexes = new Map<string, Map<string, FakeIndex>>();
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  createObjectStore(name: string, opts: { keyPath: string }) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, opts.keyPath);
    const idx = new Map<string, FakeIndex>();
    this.storeIndexes.set(name, idx);
    return {
      createIndex: (iName: string, keyPath: string) => idx.set(iName, { keyPath }),
    };
  }
  transaction(storeName: string) {
    const tx = new FakeTransaction(this, storeName);
    // put/delete 없이 즉시 완료되는 tx(read-only)도 oncomplete 를 발화시킨다.
    queueMicrotask(() => {
      if (tx.pending === 0) tx.oncomplete?.();
    });
    return tx;
  }
}

let sharedDb: FakeDb;

const fakeIndexedDB = {
  open: () => {
    const req: {
      result?: FakeDb;
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      const firstOpen = !sharedDb;
      if (firstOpen) sharedDb = new FakeDb();
      req.result = sharedDb;
      if (firstOpen) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

const fakeKeyRange = { only: (value: unknown) => ({ only: value }) };

beforeEach(() => {
  sharedDb = undefined as unknown as FakeDb;
  vi.stubGlobal("indexedDB", fakeIndexedDB);
  vi.stubGlobal("IDBKeyRange", fakeKeyRange);
});

// 동적 import 로 매 테스트마다 fresh(모듈 캐시는 openDb 상태 미보유 — 안전).
async function store() {
  return import("./offline-store");
}

describe("게스트 명단 캐시", () => {
  it("saveRoster → loadRoster 라운드트립", async () => {
    const s = await store();
    await s.saveRoster("event-1", [
      { ticketNumber: "TCKT-1", name: "홍길동", admissionMode: "allpass", status: "confirmed" },
      { ticketNumber: "TCKT-2", name: "김철수", status: "checked_in" },
    ]);
    const roster = await s.loadRoster("event-1");
    expect(roster).toHaveLength(2);
    expect(roster.map((g) => g.ticketNumber).sort()).toEqual(["TCKT-1", "TCKT-2"]);
  });

  it("이벤트 스코프 격리 — 다른 이벤트 명단은 섞이지 않음", async () => {
    const s = await store();
    await s.saveRoster("event-1", [{ ticketNumber: "A", name: "가", status: "confirmed" }]);
    await s.saveRoster("event-2", [{ ticketNumber: "B", name: "나", status: "confirmed" }]);
    expect(await s.loadRoster("event-1")).toHaveLength(1);
    expect((await s.loadRoster("event-2"))[0]?.ticketNumber).toBe("B");
  });

  it("재캐시 시 삭제된 참석자는 잔존하지 않음", async () => {
    const s = await store();
    await s.saveRoster("event-1", [
      { ticketNumber: "TCKT-1", name: "홍길동", status: "confirmed" },
      { ticketNumber: "TCKT-2", name: "김철수", status: "confirmed" },
    ]);
    // 2차 캐시에 TCKT-2 없음(취소/환불로 명단에서 빠짐).
    await s.saveRoster("event-1", [{ ticketNumber: "TCKT-1", name: "홍길동", status: "checked_in" }]);
    const roster = await s.loadRoster("event-1");
    expect(roster).toHaveLength(1);
    expect(roster[0]?.status).toBe("checked_in");
  });

  it("findGuest / searchRoster 매칭", async () => {
    const s = await store();
    await s.saveRoster("event-1", [
      { ticketNumber: "TCKT-1", name: "홍길동", status: "confirmed" },
      { ticketNumber: "TCKT-2", name: "김철수", status: "confirmed" },
    ]);
    expect((await s.findGuest("event-1", "TCKT-2"))?.name).toBe("김철수");
    expect(await s.findGuest("event-1", "없음")).toBeNull();
    const byName = await s.searchRoster("event-1", "철수");
    expect(byName).toHaveLength(1);
    expect(byName[0]?.ticketNumber).toBe("TCKT-2");
  });
});

describe("오프라인 체크인 큐", () => {
  it("enqueue → listQueue/listPending 반영(mode=offline·pending)", async () => {
    const s = await store();
    const rec = await s.enqueueOfflineCheckIn({
      eventId: "event-1",
      checkInListId: "list-1",
      ticketNumber: "TCKT-1",
      guestName: "홍길동",
      staffLabel: "스태프A",
    });
    expect(rec.mode).toBe("offline");
    expect(rec.syncState).toBe("pending");
    const queue = await s.listQueue("event-1");
    expect(queue).toHaveLength(1);
    expect(await s.listPending("event-1")).toHaveLength(1);
  });

  it("updateQueueItem 로 conflict 표시 후 pending 에서 제외", async () => {
    const s = await store();
    const rec = await s.enqueueOfflineCheckIn({
      eventId: "event-1",
      checkInListId: "list-1",
      ticketNumber: "TCKT-1",
      guestName: "홍길동",
      staffLabel: "스태프A",
    });
    await s.updateQueueItem(rec.localId, { syncState: "conflict", syncMessage: "이미 입장" });
    expect(await s.listPending("event-1")).toHaveLength(0);
    const queue = await s.listQueue("event-1");
    expect(queue[0]?.syncState).toBe("conflict");
    expect(queue[0]?.syncMessage).toBe("이미 입장");
  });

  it("clearSynced 는 synced 만 제거", async () => {
    const s = await store();
    const a = await s.enqueueOfflineCheckIn({ eventId: "event-1", checkInListId: "l", ticketNumber: "A", guestName: "가", staffLabel: "s" });
    const b = await s.enqueueOfflineCheckIn({ eventId: "event-1", checkInListId: "l", ticketNumber: "B", guestName: "나", staffLabel: "s" });
    await s.updateQueueItem(a.localId, { syncState: "synced" });
    const removed = await s.clearSynced("event-1");
    expect(removed).toBe(1);
    const queue = await s.listQueue("event-1");
    expect(queue).toHaveLength(1);
    expect(queue[0]?.localId).toBe(b.localId);
  });

  it("큐도 이벤트 스코프 격리", async () => {
    const s = await store();
    await s.enqueueOfflineCheckIn({ eventId: "event-1", checkInListId: "l", ticketNumber: "A", guestName: "가", staffLabel: "s" });
    await s.enqueueOfflineCheckIn({ eventId: "event-2", checkInListId: "l", ticketNumber: "B", guestName: "나", staffLabel: "s" });
    expect(await s.listQueue("event-1")).toHaveLength(1);
    expect(await s.listQueue("event-2")).toHaveLength(1);
  });
});
