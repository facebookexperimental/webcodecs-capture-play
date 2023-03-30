/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

class TimeChecker {
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

        // elementsList is sorted by arrival order
        while ((ret === undefined) && (i < this.elementsList.length)) {
            if (this.elementsList[i].ts >= ts) {
                ret = this.elementsList[i];
                // Remove all previous frames data
                this.elementsList = this.elementsList.slice(i + 1);
            }
            i++;
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