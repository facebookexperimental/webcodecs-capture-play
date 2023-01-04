
class TsQueue {
    constructor() {
      this.elementsList = [];
      this.totalDiscarded = 0;
      this.ptsQueue = [];
    }

    clear() {
        this.ptsQueue = [];
    }

    addToPtsQueue(ts, d) {
        this.ptsQueue.push({ts: ts, d: d});
    }

    shiftPtsQueue(numElements = 1) {
        this.ptsQueue = this.ptsQueue.slice(numElements);
    }

    removeUntil(length) {
        const removeSize = Math.max(this.ptsQueue.length - length, 0);
        if (removeSize > 0) {
            this.shiftPtsQueue(removeSize);
        }
    } 

    getPtsQueueLengthInfo() {
        const r = {lengthMs: 0, size: this.ptsQueue.length};
        this.ptsQueue.forEach(element => {
            r.lengthMs += element.d / 1000;
        });
        return r;
    }
}