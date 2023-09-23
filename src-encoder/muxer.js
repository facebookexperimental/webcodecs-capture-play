/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

importScripts('../packager/media_packager_header.js');

function chunkDataToPackager(chunkData) {
    const estimatedDuration = (chunkData.estimatedDuration === undefined) ? chunkData.chunk.duration : chunkData.estimatedDuration;    
    const ret = [];
    // Send metadata if needed
    if (chunkData.metadata != undefined) {
        //firstFrameClkms, mediaType, "init", compesatedTs, estimatedDuration, -1, Number.MAX_SAFE_INTEGER, metadata, packagerVersion
        const packager = new MediaPackagerHeader();
        packager.SetData(Number.MAX_SAFE_INTEGER, chunkData.mediaType, chunkData.compesatedTs, estimatedDuration, "init", -1, chunkData.firstFrameClkms, chunkData.metadata);
        ret.push(packager);
    }

    const packager = new MediaPackagerHeader();
    const buf = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(buf);
    packager.SetData(chunkData.maxAgeChunkS, chunkData.mediaType, chunkData.compesatedTs, estimatedDuration, chunkData.chunk.type, chunkData.seqId, chunkData.firstFrameClkms, buf);
    ret.push(packager);

    return ret;
}
