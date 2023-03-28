/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

class PackagerVersion {
    // Create new instances of the same class as static attributes
    static V1Json = new PackagerVersion("V1Json")
    static V2Binary = new PackagerVersion("V2Binary")

    constructor(name) {
        this.name = name
    }

    ["=="] = function (operand) {
        return this.name == operand.name;
    }
}
