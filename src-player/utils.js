/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

class StateEnum {
    // Create new instances of the same class as static attributes
    static Created = new StateEnum("created")
    static Instantiated = new StateEnum("instantiated")
    static Running = new StateEnum("running")
    static Stopped = new StateEnum("stopped")

    constructor(name) {
        this.name = name
    }
}

function sendMessageToMain(prefix, type, data) {
    if (type === "debug" || type === "info" || type === "error" || type === "warning") {
        data = prefix + " " + data;
    }
    self.postMessage({type: type, data: data});
}

function base64ToArrayBuffer(base64) {
    const binary_string =  atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array( len );
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

function deSerializeMetadata(metadata) {
    const decoder = new TextDecoder();
    const str = decoder.decode(metadata);
    const data = JSON.parse(str);

    if (('decoderConfig' in data) && ('descriptionInBase64' in data.decoderConfig)) {
        data['decoderConfig']['description'] = base64ToArrayBuffer(data.decoderConfig.descriptionInBase64);
        delete data['decoderConfig']['descriptionInBase64'];
    }
    return data['decoderConfig'];
}