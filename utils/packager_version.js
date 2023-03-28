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
