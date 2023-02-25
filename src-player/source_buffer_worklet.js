/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const SharedStates = {
    'AUDIO_BUFF_START': 0, // The reader only modifies this pointer
    'AUDIO_BUFF_END': 1, // The writer (this) only modifies this pointer

    'AUDIO_INSERTED_SILENCE_MS': 2,

    'IS_PLAYING' : 3, // Indicates playback state
};

class SourceBuffer extends AudioWorkletProcessor {
    // Custom AudioParams can be defined with this static getter.
    static get parameterDescriptors() {
        return [];
    }

    constructor() {
        // The super constructor call is required.
        super();

        this.contextSampleFrequency = -1;
        
        this.port.onmessage = this.handleMessage.bind(this);

        this.totalSilenceInsertedSamples = 0;

        this.sharedCommBuffer = null;
        this.sharedAudiobuffers = null;
        this.circularBufferSizeSamples = 0;
    }

    handleMessage(e) {
        if (e.data.type === 'iniabuffer') {
            if ('config' in e.data) {
                if ('contextSampleFrequency' in e.data.config) {
                    this.contextSampleFrequency = e.data.config.contextSampleFrequency;
                }
                if ('cicularAudioSharedBuffers' in e.data.config) {
                    this.sharedCommBuffer = e.data.config.cicularAudioSharedBuffers.sharedCommBuffer;
                    this.sharedAudiobuffers = e.data.config.cicularAudioSharedBuffers.sharedAudiobuffers;
                    
                    // States access
                    this.sharedStates = new Int32Array(this.sharedCommBuffer);
                }
                if ('circularBufferSizeSamples' in e.data.config) {
                    this.circularBufferSizeSamples = e.data.config.circularBufferSizeSamples;
                }
            }
        }
    }

    process(inputs, outputs, parameters) {
        // Assume single input
        const outputFirstTrack = outputs[0];
        // Assuming all channels has same length
        const numOutSamplesFirstChannel = outputFirstTrack[0].length;
        if ((numOutSamplesFirstChannel == undefined) || (numOutSamplesFirstChannel <= 0)) {
            throw 'Num samples to process for 1st channel is not valid';
        }
        if (this.sharedCommBuffer === null) {
            return true; // Not init yet
        }
        const isPlaying = Atomics.load(this.sharedStates, SharedStates.IS_PLAYING);
        if (isPlaying === 0) {
            return true; // Not in playing state yet
        }

        if (this.circularBufferSizeSamples <= 0) {
            throw 'Bad size for circular audio buffer';
        }

        const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START);
        const end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END);

        if (start < 0 || end < 0) {
            return true;
        }
        if (numOutSamplesFirstChannel > this._getUsedSlots(start, end)) {
            this.totalSilenceInsertedSamples += numOutSamplesFirstChannel;
            const totalSilenceInsertedMs = this.totalSilenceInsertedSamples * 1000 / this.contextSampleFrequency;
            Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, totalSilenceInsertedMs);
        } else {
            // Loop all channels
            if (start + numOutSamplesFirstChannel <= this.circularBufferSizeSamples) {
                // All
                for (let c = 0; c < outputFirstTrack.length; c++) {
                    const outputRingBufferPortion = new Float32Array(this.sharedAudiobuffers[c], start * Float32Array.BYTES_PER_ELEMENT, numOutSamplesFirstChannel);
                    outputFirstTrack[c].set(outputRingBufferPortion);
                }

                Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, start + numOutSamplesFirstChannel);
            } else {
                const samplesToCopyFirstHalf = this.circularBufferSizeSamples - start;
                const samplesToCopySecondsHalf = numOutSamplesFirstChannel - samplesToCopyFirstHalf;
                for (let c = 0; c < outputFirstTrack.length; c++) {
                    // First half
                    const outputRingBufferPortionFirstHalf = new Float32Array(this.sharedAudiobuffers[c], start * Float32Array.BYTES_PER_ELEMENT, samplesToCopyFirstHalf);
                    outputFirstTrack[c].set(outputRingBufferPortionFirstHalf);
                    // Second half
                    const outputRingBufferPortionSecondHalf = new Float32Array(this.sharedAudiobuffers[c], 0, samplesToCopySecondsHalf);
                    outputFirstTrack[c].set(outputRingBufferPortionSecondHalf, samplesToCopyFirstHalf);
                }

                Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, samplesToCopySecondsHalf);
            }
        }
        return true;
    }

    _getUsedSlots(start, end) {
        if (start === end) {
            return 0;
        } else if (end > start) {
            return end - start;
        } else {
            return (this.circularBufferSizeSamples - start) + end;
        }
    }
}
registerProcessor('source-buffer', SourceBuffer);
