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

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode( bytes[ i ] );
    }
    return btoa(binary);
}

function serializeMetadata(metadata) {
    let ret = undefined;
    if ((metadata != undefined) && ('decoderConfig' in metadata)) {
        newData = {};
        // Copy all enumerable own properties
        newData['decoderConfig'] = Object.assign({}, metadata.decoderConfig);
        // Description is buffer
        if ('description' in metadata.decoderConfig) {
            newData['decoderConfig']['descriptionInBase64'] = arrayBufferToBase64(metadata.decoderConfig.description);
            delete newData.description;
        }
        // Encode
        const encoder = new TextEncoder();
        ret = encoder.encode(JSON.stringify(newData));
    }
    return ret;
}
