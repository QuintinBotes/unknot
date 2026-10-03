export class Queue {
  constructor() {
    this.items = [];
    this.waiting = new Map();
  }

  push(value) {
    this.items.push(value);
    const waiter = this.waiting.get('next');
    if (waiter) {
      this.waiting.delete('next');
      waiter(this.items.shift());
    }
  }

  async pop() {
    if (this.items.length > 0) {
      return this.items.shift();
    }
    return new Promise((resolve) => {
      this.waiting.set('next', resolve);
    });
  }

  get size() {
    return this.items.length;
  }
}
