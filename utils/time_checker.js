/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

class returnWhen {
    // Create new instances of the same class as static attributes
    static GreaterOrEqual = new returnWhen("GreaterOrEqual")
    static LowerOrEqual = new returnWhen("LowerOrEqual")

    constructor(name) {
        this.name = name
    }
}

class TimeChecker {
    constructor(mediaType, returnIfGreater) {
        this.mediaType = mediaType;
        this.elementsList = [];

        this.mode = returnWhen.GreaterOrEqual;
        if (returnIfGreater === returnWhen.LowerOrEqual) {
            this.mode = returnWhen.LowerOrEqual;
        }
    }

    AddItem(item) {
        if (('ts' in item) && ('clkms' in item)) {
            // Add at the end
            this.elementsList.push(item);
        }
    }

    GetItemByTs(ts) {
        let ret = undefined;
        let i = 0;

        // elementsList is sorted by arrival order
        while ((ret === undefined) && (i < this.elementsList.length)) {
            if (this.checkCondition(this.elementsList[i].ts, ts)) {
                ret = this.elementsList[i];
                // Remove all previous frames data
                this.elementsList = this.elementsList.slice(i + 1);
            }
            i++;
        }

        /*if (ret === undefined) {
            console.log("JOC elements list: " + this.elementsList.length + ", retTs: undefined, asked: " + ts + ", " + JSON.stringify(this.elementsList))
        } else {
            console.log("JOC elements list: " + this.elementsList.length + ", retTs: " + ret.ts + ", asked: " + ts + ", " + JSON.stringify(this.elementsList))
        }*/

        return ret;
    }

    Clear() {
        this.elementsList = [];
    }

    checkCondition(elementTs, ts) {
        let ret = false;
        if (this.mode === returnWhen.GreaterOrEqual) {
            ret = elementTs >= ts;
        } else {
            ret = elementTs <= ts;
        }
        return ret;
    }
}

class LatencyChecker {
    constructor(mediaType) {
        this.mediaType = mediaType;
        this.elementsList = [];
    }

    AddItem(item) {
        if (('ts' in item) && ('clkms' in item)) {
            // Add at the end
            this.elementsList.push(item);
        }
    }

    GetItemByTs(ts) {
        let ret = undefined;
        let i = 0;
        let indexPastTs = -1

        // elementsList is sorted by arrival order
        while ((i < this.elementsList.length) && (indexPastTs < 0)) {
            if (this.elementsList[i].ts > ts) {
                indexPastTs = i - 1;
            }
            i++;
        }
        if (indexPastTs >= 0) {
            ret = this.elementsList[indexPastTs];
            this.elementsList = this.elementsList.slice(indexPastTs + 1);
        }

        /*if (ret === undefined) {
            console.log("JOC elements list: " + this.elementsList.length + ", retTs: undefined, asked: " + ts + ", " + JSON.stringify(this.elementsList) + ", mode: " + this.mode)
        } else {
            console.log("JOC elements list: " + this.elementsList.length + ", retTs: " + ret.ts + ", asked: " + ts + ", " + JSON.stringify(this.elementsList) + ", mode: " + this.mode)
        }*/

        return ret;
    }

    Clear() {
        this.elementsList = [];
    }
}