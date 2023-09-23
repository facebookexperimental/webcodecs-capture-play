/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

class MediaPackagerHeader {
    constructor() {
        this.maxAgeS = -1;
        this.mediaType = "";
        this.timestamp = 0;
        this.duration = 0;
        this.chunkType = "";
        this.seqId = -1;
        this.firstFrameClkms = 0;
        this.pId = "";
        this.data = null;

        // Valid when we transform to bytes
        this.totalPayloadBytes = 0;
        this.totalPackagerBytes = 0;
    }

    SetData(maxAgeS, mediaType, timestamp, duration, chunkType, seqId, firstFrameClkms, data) {
        const pId = btoa(`${mediaType}-${timestamp}-${chunkType}-${seqId}-${Math.floor(Math.random * 100000)}`);

        this.maxAgeS = maxAgeS;
        this.mediaType = mediaType;
        this.timestamp = timestamp;
        this.duration = duration;
        this.chunkType = chunkType;
        this.seqId = seqId;
        this.firstFrameClkms = firstFrameClkms;
        this.pId = pId;
        this.data = data;
    }

    GetData() {
        return {
            maxAgeS: this.maxAgeS,
            mediaType: this.mediaType,
            timestamp: this.timestamp,
            duration: this.duration,
            chunkType: this.chunkType,
            seqId: this.seqId,
            firstFrameClkms: this.firstFrameClkms,
            pId: this.pId,
            data: this.data
        }
    }

    GetDataStr() {
        return this.mediaType + "-" + this.seqId + "-" + this.timestamp + "-" + this.duration + "-" + this.chunkType + "-" + this.firstFrameClkms
    }

    SetDataFromBytes(bytes) {
        const dw = new DataView(bytes.buffer);

        if (bytes.byteLength < 1) {
            throw "No enough bytes to read version from header";
        }
        const protVersionFlag = dw.getUint8(0)
        if (protVersionFlag == 0xff) {
            this.decodeV2(bytes)
        } else {
            this.decodeV1(bytes)
        }

    }

    ToBytes(version) {
        if (version == PackagerVersion.V2Binary) {
            return this.encodeV2();
        }
        return this.encodeV1();
    }

    GetPackagerInfo() {
        return { packagerBytes: this.totalPackagerBytes, payloadBytes: this.totalPayloadBytes };
    }

    // Internal

    decodeV1(bytes) {
        const headerJson = new TextDecoder().decode(bytes);
        const header = JSON.parse(headerJson)

        if ('Cache-Control' in header) {
            const cacheControlStr = header['Cache-Control'];
            const m = /max-age=(?<maxage>\d*)/.exec(cacheControlStr);
            if ('groups' in m && 'maxage' in m.groups && !isNaN(m.groups.maxage)) {
                this.maxAgeS = parseInt(m.groups.maxage)
            }
        }

        this.chunkType = header['Joc-Chunk-Type']; // init, key, delta
        this.mediaType = header['Joc-Media-Type']; // audio, video

        // Check this logic
        if (('Joc-Seq-Id' in header) && !isNaN(header['Joc-Seq-Id'])) {
            this.seqId = parseInt(header['Joc-Seq-Id']);
        }
        if (('Joc-Timestamp' in header) && !isNaN(header['Joc-Timestamp'])) {
            this.timestamp = parseInt(header['Joc-Timestamp']);
        }
        if (('Joc-Duration' in header) && !isNaN(header['Joc-Duration'])) {
            this.duration = parseInt(header['Joc-Duration']);
        }
        if (('Joc-First-Frame-Clk' in header) && !isNaN(header['Joc-First-Frame-Clk'])) {
            this.firstFrameClkms = parseInt(header['Joc-First-Frame-Clk']);
        }
        if ('Joc-Uniq-Id' in header) {
            this.pId = header['Joc-Uniq-Id'];
        }
    }

    decodeV2(bytes) {
        const dw = new DataView(bytes.buffer);
        let pos = 0;
        if (bytes.byteLength < pos + 1) {
            throw "No enough bytes to read version from header";
        }
        const protVersionFlag = dw.getUint8(pos)
        if (protVersionFlag != 0xFF) {
            throw `protVersionFlag different than 0xFF, current value: ${protVersionFlag}`;
        }
        pos++;

        if (bytes.byteLength < pos + 1) {
            throw "No enough bytes to read data byte";
        }
        const dataByte = dw.getUint8(pos)
        if (((dataByte >> 6) & 0b11) == 0) {
            this.mediaType = "audio"
        } else if (((dataByte >> 6)& 0b11) == 1){
            this.mediaType = "video"
        } else {
            throw `Invalid mediaType, current dataByte: ${dataByte}`;
        }
        if (((dataByte >> 4) & 0b11) == 0) {
            this.chunkType = "delta"
        } else if (((dataByte >> 4)& 0b11) == 1){
            this.chunkType = "key"
        } else if (((dataByte >> 4)& 0b11) == 2){
            this.chunkType = "init"
        } else {
            throw `Invalid chunkType, current dataByte: ${dataByte}`;
        }

        let validDuration = false
        if ((dataByte & 0b00001000) > 0) {
            validDuration = true
        }
        let validFirstFrameClk = false
        if ((dataByte & 0b00000100) > 0) {
            validFirstFrameClk = true
        }
        let validSeqId = false
        if ((dataByte & 0b00000010) > 0) {
            validSeqId = true
        }
        let validTimestamp = false
        if ((dataByte & 0b00000001) > 0) {
            validTimestamp = true
        }
        pos++;

        if (bytes.byteLength < pos + 4) {
            throw "No enough bytes to read cacheControl";
        }
        this.maxAgeS = dw.getUint32(pos)
        pos += 4;

        if (validSeqId) {
            if (bytes.byteLength < pos + 8) {
                throw "No enough bytes to read seqId";
            }
            this.seqId = Number(dw.getBigInt64(pos))
            pos += 8;
        }
        
        if (validTimestamp) {
            if (bytes.byteLength < pos + 8) {
                throw "No enough bytes to read timestamp";
            }
            this.timestamp = Number(dw.getBigInt64(pos))
            pos += 8;
        }

        if (validDuration) {
            if (bytes.byteLength < pos + 8) {
                throw "No enough bytes to read duration";
            }
            this.duration = Number(dw.getBigInt64(pos))
            pos += 8;
        }

        if (validFirstFrameClk) {
            if (bytes.byteLength < pos + 8) {
                throw "No enough bytes to read FirstFrameClk";
            }
            this.firstFrameClkms = Number(dw.getBigInt64(pos))
            pos += 8;
        }
    }

    getHeaders() {
        const headers = {
            'Joc-Media-Type': this.mediaType, // String
            'Joc-Chunk-Type': this.chunkType, // String
        };
        if (this.maxAgeS != undefined && !isNaN(this.maxAgeS) && this.maxAgeS > 0) {
            headers['Cache-Control'] = `max-age=${this.maxAgeS}`; // String
        } else {
            headers['Cache-Control'] = 'max-age=0'; // String
        }
        if (this.seqId != undefined && !isNaN(this.seqId)) {
            headers['Joc-Seq-Id'] = this.seqId; // Number
        }
        if (this.firstFrameClkms != undefined && !isNaN(this.firstFrameClkms)) {
            headers['Joc-First-Frame-Clk'] = this.firstFrameClkms; // Number
        }
        if (this.pId != undefined) {
            headers['Joc-Uniq-Id'] = this.pId; // String
        }
        if (this.duration != undefined && !isNaN(this.duration)) {
            headers['Joc-Duration'] = this.duration; // Number
        }
        if (this.timestamp != undefined && !isNaN(this.timestamp)) {
            headers['Joc-Timestamp'] = this.timestamp; // Number
        }

        return headers;
    }

    encodeV1() {
        const headerUtf8Bytes = new TextEncoder().encode(JSON.stringify(this.getHeaders()));
        const headerUtf8SizeBytes = this.convertToUint64BE(headerUtf8Bytes.byteLength);

        this.totalPackagerBytes = headerUtf8Bytes.byteLength + 8;
        if (this.data != undefined) {
            this.totalPayloadBytes = this.data.byteLength;
        }
        return this.concatBuffer([headerUtf8SizeBytes, headerUtf8Bytes, this.data]);
    }

    encodeV2() {
        const versionByte = this.convertToUint8(0xff);
        const timestampByte = this.convertToInt64BE(this.timestamp);
        // TODO: Convert to UINT
        const durationByte = this.convertToInt64BE(this.duration);
        // TODO: Convert to UINT
        const seqIDByte = this.convertToInt64BE(this.seqId);
        const maxAgeByte = this.convertToUint32BE(this.maxAgeS);
        // TODO: Convert to UINT
        const firstFrameClkmsByte = this.convertToInt64BE(this.firstFrameClkms);

        const dataByte = this.createDataByte(this.mediaType, this.chunkType, (seqIDByte != undefined), (timestampByte != undefined), (durationByte != undefined), (firstFrameClkmsByte != undefined));
        const totalHeaderSize = 1 + 8 + 8 + 8 + 8 + 4 + 1; //38 bytes
        // TODO: 
        // We could add maxAge default per track (-4), 
        // We could add duration default per track (-8),
        // firstFrameClkmsByte is optional (-8) 
        const headerSizeBytes = this.convertToUint64BE(totalHeaderSize);

        this.totalPackagerBytes = 8 + totalHeaderSize;
        if (this.data != undefined) {
            this.totalPayloadBytes = this.data.byteLength;
        }

        return this.concatBuffer([headerSizeBytes, versionByte, dataByte, maxAgeByte, seqIDByte, timestampByte, durationByte, firstFrameClkmsByte, this.data]);
    }

    createDataByte(mediaType, chunkType, validSeqId, validTimestamp, validDuration, validFirstFrameClkms) {
        let byte = 0;
        if (mediaType === 'audio') {
            byte = byte | 0b00000000;
        } else if (mediaType === 'video') {
            byte = byte | 0b01000000;
        }

        if (chunkType === 'delta') {
            byte = byte | 0b00000000;
        } else if (chunkType === 'key') {
            byte = byte | 0b00010000;
        } else if (chunkType === 'init') {
            byte = byte | 0b00100000;
        }

        if (validDuration) {
            byte = byte | 0b00001000;
        }
        if (validFirstFrameClkms) {
            byte = byte | 0b00000100;
        }
        if (validSeqId) {
            byte = byte | 0b00000010;
        }
        if (validTimestamp) {
            byte = byte | 0b00000001;
        }

        return this.convertToUint8(byte);
    }

    concatBuffer(arr) {
        let totalLength = 0;
        arr.forEach(element => {
            if (element != undefined) {
                totalLength += element.byteLength;
            }
        });
        const retBuffer = new Uint8Array(totalLength);
        let pos = 0;
        arr.forEach(element => {
            if (element != undefined) {
                retBuffer.set(element, pos);
                pos += element.byteLength;
            }
        });
        return retBuffer;
    }

    convertToInt64BE(val) {
        return this.convertToIntBE(8, val);
    }
    convertToUint64BE(val) {
        return this.convertToUintBE(8, val);
    }
    convertToUint32BE(val) {
        return this.convertToUintBE(4, val);
    }
    convertToUint24BE(val) {
        return this.convertToUintBE(3, val);
    }
    convertToUint16BE(val) {
        return this.convertToUintBE(2, val);
    }
    convertToUint8(val) {
        return this.convertToUintBE(1, val);
    }
    convertToIntBE(sizeBytes, val) {
        let b = this.convertToUintBE(sizeBytes, val);
        if (val < 0) {
            b[0] = b[0] | 0b10000000;
        } else {
            b[0] = b[0] & 0b01111111;
        }
        return b;
    }
    convertToUintBE(sizeBytes, val) {
        if (isNaN(val) === true) {
            return undefined;
        }
        const b = new Uint8Array(sizeBytes);
        let src = BigInt(val);
        for (let n = sizeBytes - 1; n >= 0; n--) {
            b[n] = Number(src) & 0xFF;
            src = src >> 8n;
        }
        return b;
    }
}
