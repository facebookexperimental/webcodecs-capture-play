
class TimeChecker {
    constructor(mediaType) {
      this.mediaType = mediaType;
      this.elementsList = [];
    }

    AddItem(item) {
        if (('ts' in item) && ('clkms' in item) && ('compesatedTs' in item) && ('estimatedDuration' in item)) {
            // Add at the end
            //console.debug(`[TIME-CHECK-${this.mediaType}] - Added item ts: ${item.ts}`);
            this.elementsList.push(item);
        }
    }

    GetItemByTs(ts) {
        let ret = undefined;
        let bFound  = false;
        let i = 0;

        // elementsList is sorted by arrival order
        while ((!bFound) && (i < this.elementsList.length)) {
            //console.debug(`[TIME-CHECK-${this.mediaType}] - checking element with ts: ${this.elementsList[i].ts} for ${ts}`);
            if (this.elementsList[i].ts >= ts) {
                bFound = true;
                ret = this.elementsList[i];
                // Remove all previous frames data
                this.elementsList = this.elementsList.slice(i+1);
            }
            i++;
        }

        // Debug 
        //console.debug(`[TIME-CHECK-${this.mediaType}] - List length ${this.elementsList.length}`);
        return ret;
    }
  }