/**
 * 트랙 2.3 — 빌더 Undo/Redo (command pattern, 50 history 한도)
 *
 * 빌더 상태(SeatNode[]) 의 스냅샷을 push 하면 stack 에 저장되어
 * undo/redo 가 가능하다. 각 스냅샷은 구조 복사된 배열이라 mutation 안전.
 */

const MAX_HISTORY = 50;

export class History<T> {
  private stack: T[] = [];
  private cursor = -1;

  push(snapshot: T) {
    // 새 push 가 들어오면 cursor 이후의 history 는 버린다 (redo 무효화)
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(snapshot);
    if (this.stack.length > MAX_HISTORY) {
      this.stack.shift();
    } else {
      this.cursor += 1;
    }
  }

  undo(): T | null {
    if (this.cursor <= 0) return null;
    this.cursor -= 1;
    return this.stack[this.cursor] ?? null;
  }

  redo(): T | null {
    if (this.cursor >= this.stack.length - 1) return null;
    this.cursor += 1;
    return this.stack[this.cursor] ?? null;
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor < this.stack.length - 1;
  }

  reset(initial: T) {
    this.stack = [initial];
    this.cursor = 0;
  }

  size(): number {
    return this.stack.length;
  }
}
