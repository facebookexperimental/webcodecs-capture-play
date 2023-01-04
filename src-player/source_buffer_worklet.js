class SourceBuffer extends AudioWorkletProcessor {
    // Custom AudioParams can be defined with this static getter.
    static get parameterDescriptors() {
        return [];
    }

    constructor() {
        // The super constructor call is required.
        super();

        this.contextSampleFrequency = -1;
        this.sampleFrequency = -1;
        this.numberOfChannels = -1;

        // Float32
        this.audioSampleFrameBuffer = [];

        // Used to keep relation audioSampleFrameBuffer index - timestamp
        // Only channel 0 considered. Assuming channels are aligned
        this.audioSampleIndexToTimestamp = [];

        this.port.onmessage = this.handleMessage.bind(this);

        this.isFirstFrame = true;

        this.totalSilenceInsertedSamples = 0;

        class AudioFrameQueue {
            constructor() {
                this.frameQueue = [];
                this.currentFrameIndexSample = 0;
                this.totalSamples = 0;
                this.lastInsertedSampleTimestamp = -1;
                this.sampleRate = -1;
            }

            addFrame(aframe) {
                if (this.sampleRate < 0) {
                    this.sampleRate = aframe.sampleRate;
                }
                this.totalSamples += aframe.numberOfFrames;
                this.frameQueue.push(aframe);
            }
        
            clear() {
                this.totalSamples = 0;
                while (this.frameQueue.length > 0) {
                    const aFrame = this.frameQueue.shift();
                    aFrame.close();
                }
                this.totalSamples = 0;
            }

            getQueueInfo() {
                const r = {lengthMs: 0, size: this.frameQueue.length, lastInsertedSampleTimestamp: this.lastInsertedSampleTimestamp};
                if (this.sampleRate > 0 && this.totalSamples > 0) {
                    r.lengthMs = this.totalSamples * 1000 / this.sampleRate
                }
                return r;
            }

            copySamples (firstTrack) {
                const numSamples = firstTrack[0].length;
                const r = {lastInsertedSampleTimestamp: this.lastInsertedSampleTimestamp, samplesInserted: 0, silenceSamples: numSamples};
                r.samplesInserted = 0;                

                while (this.frameQueue.length > 0 && r.samplesInserted < numSamples) {
                    const aFrame = this.frameQueue[0];
                    const samplesToCopyFromThisFrame = Math.min(numSamples - r.samplesInserted, aFrame.numberOfFrames - this.currentFrameIndexSample);
        
                    for (let c = 0; c < aFrame.numberOfChannels; c++) {
                        aFrame.copyTo(firstTrack[c], {planeIndex: c, frameOffset: this.currentFrameIndexSample, frameCount: samplesToCopyFromThisFrame});
                    }
        
                    this.currentFrameIndexSample += samplesToCopyFromThisFrame;
                    r.samplesInserted += samplesToCopyFromThisFrame;
                    r.silenceSamples -= samplesToCopyFromThisFrame;
                    this.lastInsertedSampleTimestamp = aFrame.timestamp + Math.floor(samplesToCopyFromThisFrame * 1000 * 1000 / aFrame.sampleRate);
                    r.lastInsertedSampleTimestamp = this.lastInsertedSampleTimestamp;
                    
                    if (this.currentFrameIndexSample >= aFrame.numberOfFrames) {
                        this.totalSamples -= aFrame.numberOfFrames;
                        this.frameQueue.shift();
                        aFrame.close();
                        this.currentFrameIndexSample = 0;
                    }
                }
                return r;
            }
        }

        this.audioFrameQueue = new AudioFrameQueue();
    }

    addToFrameBuffer(aFrame) {
        if (this.contextSampleFrequency < 0) {
            aFrame.close();
            throw 'Audio frame added before initialization'
        }
        if (this.sampleFrequency < 0) {
            this.sampleFrequency = aFrame.sampleRate;
        } else {
            if (this.sampleFrequency != this.contextSampleFrequency) {
                aFrame.close();
                throw 'Error sampling frequency received does NOT match local audio rendered, needs more work :-): sampleFrequency: ' + this.sampleFrequency + ", contextSampleFrequency: " + this.contextSampleFrequency;
            }
        }
        if (this.numberOfChannels < 0) {
            this.numberOfChannels = aFrame.numberOfChannels;
        } else {
            if (this.numberOfChannels != aFrame.numberOfChannels) {
                aFrame.close();
                throw 'Error channels NOT match previous data, needs more work :-): old numberOfChannels: ' + this.numberOfChannels + ", new numberOfChannels: " + aFrame.numberOfChannels;
            }
        }

        this.audioFrameQueue.addFrame(aFrame);
                
        // Send stats
        if ((this.audioSampleFrameBuffer.length > 0) && (this.contextSampleFrequency > 0)) {
            const totalSilenceInsertedMs = (this.totalSilenceInsertedSamples * 1000) / this.contextSampleFrequency;
            const queueInfo = this.audioFrameQueue.getQueueInfo();
            this.port.postMessage({type: "audiosourcebufferstats", totalSilenceInsertedMs: totalSilenceInsertedMs, silenceInsertedMs: 0, currentTimestamp: queueInfo.lastInsertedSampleTimestamp, queueSize: queueInfo.size, queueLengthMs: queueInfo.lengthMs});
        }
    }

    handleMessage(e) {
        if (e.data.type === 'iniabuffer') {
            if (('config' in e.data) && ('contextSampleFrequency' in e.data.config)) {
                this.contextSampleFrequency = e.data.config.contextSampleFrequency;
            }
        } else if (e.data.type === 'removebuffer') {
            this.audioFrameQueue.clear();
        } else if (e.data.type === 'audioframe') {
            this.addToFrameBuffer(e.data.frame);
        }
    }

    process(inputs, outputs, parameters) {
        // Assume single input
        const outputFirstTrack = outputs[0];
        // Assuming all channels has same length
        const numOutSamplesFirstChannel = outputFirstTrack[0].length;
        if ((numOutSamplesFirstChannel == undefined) || (numOutSamplesFirstChannel <= 0)) {
            throw 'Num samples to process for 1st channel is not valid'
        }

        const data = this.audioFrameQueue.copySamples(outputFirstTrack);

        // Notify silence inserted samples
        this.totalSilenceInsertedSamples += data.silenceSamples;
        const silenceInsertedMs = (data.silenceSamples * 1000) / this.contextSampleFrequency;
        const totalSilenceInsertedMs = (this.totalSilenceInsertedSamples * 1000) / this.contextSampleFrequency;
        
        // Send stats
        this.port.postMessage({type: "audiosourcebufferstats", totalSilenceInsertedMs: totalSilenceInsertedMs, silenceInsertedMs: silenceInsertedMs, currentTimestamp: data.lastInsertedSampleTimestamp, queueSize: this.audioFrameQueue.getQueueInfo().size, queueLengthMs: this.audioFrameQueue.getQueueInfo().lengthMs});

        return true;
    }
}
registerProcessor('source-buffer', SourceBuffer);
