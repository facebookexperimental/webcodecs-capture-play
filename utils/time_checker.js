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
    constructor(mediaType, returnIfGreated) {
        this.mediaType = mediaType;
        this.elementsList = [];

        this.mode = returnWhen.GreaterOrEqual;
        if (returnIfGreated === returnWhen.LowerOrEqual) {
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
            if (this.checkCondtion(this.elementsList[i].ts, ts)) {
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

    checkCondtion(elementTs, ts) {
        let ret = false;
        if (this.mode === returnWhen.GreaterOrEqual) {
            ret = elementTs >= ts;
        } else {
            ret = elementTs <= ts;
        }
        return ret;
    }
}