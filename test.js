var RTCPeerConnection = require('wrtc').RTCPeerConnection;
var Socket = require("ws");
var wrtcConfig = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] };

var Debug = /** @class */ (function () {
    function Debug() {
    }
    Debug.log = function (msg, level) {
        if (level === void 0) { level = 3; }
        if (this.debugLevel >= level) {
            console.log(msg);
        }
    };
    Debug.debugLevel = 4;
    return Debug;
}());

var Request = /** @class */ (function () {
    function Request(msg) {
        this.parseError = false;
        this.data = null;
        Debug.log(msg.data, 4);
        try {
            var parsed = JSON.parse(msg.data);
            this.command = parsed.command;
            this.data = parsed.data;
            this.id = parsed.id;
            this.token = parsed.token;
        }
        catch (SyntaxError) {
            this.parseError = true;
        }
    }
    return Request;
}());

const server = new Socket.Server({port: 8080});


server.on('connection', (sock) => {
    Debug.log("Got connection");

    let peerConnection = new RTCPeerConnection(wrtcConfig);

    sock.onmessage = async (msg) => {
        console.log("message")
        let req = new Request(msg);

        if (req.parseError === true) {
            console.log("PARSE ERROR")
            // this.close();
            return;
        }

        switch (req.command) {
            case "offer":
                Debug.log("Offer");
                await peerConnection.setRemoteDescription(req.data);
                let answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);

                sock.send(JSON.stringify({sdp: answer, error: false}));
                break;
            case "iceCandidate":
                Debug.log("ICE");
                await peerConnection.addIceCandidate(req.data)
                break;
        }
    };

    peerConnection.onicecandidate = event => {
        // Check if the event has a candidate property
        Debug.log("Self ICE outside");
        if (event.candidate) {
            Debug.log("Self ICE");
            // Send the ICE candidate to the receiver over a signaling channel
            sock.send(JSON.stringify({iceCandidate: event.candidate, error: false}));
        }
    };
});
