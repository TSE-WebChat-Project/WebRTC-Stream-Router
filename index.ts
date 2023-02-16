import {WebSocketServer} from "ws";

const { RTCPeerConnection } = require('wrtc');
const Socket = require("ws");
const wrtcConfig = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]}
const wrtcOptions = {offerToReceiveAudio: true, offerToReceiveVideo: true}


// Debug messages
class Debug{
    static debugLevel: number = 4
    static log(msg: string, level: number = 3): void{
        if(this.debugLevel >= level){
            console.log(msg);
        }
    }
}

// Handle socket request parsing
class Request{
    public readonly parseError: boolean = false;
    public readonly command: string;
    public readonly data: any = null;
    public readonly id: string;
    public readonly token: string;

    constructor(msg: MessageEvent) {
        Debug.log(msg.data, 4)
        try{
            let parsed = JSON.parse(msg.data);
            this.command = parsed.command
            this.data = parsed.data;
            this.id = parsed.id;
            this.token = parsed.token;
        }
        catch (SyntaxError){
            this.parseError = true;
        }
    }
}

// Generate socket responses
class Response {
    static INVALID_REQUEST: string = JSON.stringify({"message": "Invalid request", "error": true});
    static AUTH_FAILED: string = JSON.stringify({"message": "Invalid auth", "error": true});

    static generateAnswerResponse(answer: any){
        return JSON.stringify({"message": "SDP answer", "sdp": answer, "error": false})
    }

    static generateIceMessage(candidate: RTCIceCandidate){
        return JSON.stringify({"message": "New ICE Candidate", "candidate": candidate, "error": false})
    }
}

// Stores information about the client
class Client {
    private id_: string|null = null;
    private socket: WebSocket;
    private peerConnection: RTCPeerConnection;

    constructor(socket) {
        this.socket = socket;
        this.socket.onmessage = (msg: MessageEvent) => {this.socketMessage(msg)}
        this.peerConnection = new RTCPeerConnection(wrtcConfig);

        this.peerConnection.onconnectionstatechange = () => {
            switch (this.peerConnection.connectionState) {
                case "connected":
                    Debug.log("WebRTC connection established");
                    break;
                case "disconnected":
                    Debug.log("WebRTC connection lost");
                    break;
            }
        };

        this.peerConnection.onicecandidate = event => {
            // Check if the event has a candidate property
            Debug.log("Self ICE outside");
            if (event.candidate) {
                Debug.log("Self ICE");
                // Send the ICE candidate to the receiver over a signaling channel
                this.sendIce(event.candidate);
            }
        };
    }

    get id(){
        return this.id_
    }

    private getAuthentication(req: Request){
        if(this.id_ == null){
            this.id_ = req.id;
        }
        else if (this.id_ != req.id){
            return false;
        }

        if(req.token == "testauth"){ // ToDo: implement authentication
            Debug.log("Authenticated", 4);
            // this.send(JSON.stringify({"message": "Authenticated", "error": false}));
            return true;
        }
        return false;
    }

    socketSend(string: string): void{
        this.socket.send(string);
    }

    private socketMessage(msg: MessageEvent): void {
        let req = new Request(msg);

        if (req.parseError == true) {
            this.socketSend(Response.INVALID_REQUEST);
            // this.close();
            return;
        }

        // Authenticate
        if (!this.getAuthentication(req)) {
            Debug.log("Auth failed", 4);
            this.socketSend(Response.AUTH_FAILED);
            this.socket.close();
            return;
        }

        switch (req.command) {
            case "offer":
                Debug.log("Offer");
                this.processOffer(req.data);
                break;
            case "iceCandidate":
                Debug.log("ICE");
                if(req.data.candidate){
                    this.peerConnection.addIceCandidate(req.data);
                }
                break;
        }
    }

    private async processOffer(offer: any){
        await this.peerConnection.setRemoteDescription(offer);
        let answer = await this.peerConnection.createAnswer(wrtcOptions);
        await this.peerConnection.setLocalDescription(answer);

        this.socketSend(Response.generateAnswerResponse(answer));
    }

    private sendIce(candidate: RTCIceCandidate){
        this.socketSend(Response.generateIceMessage(candidate));
    }
}

const server: WebSocketServer = new Socket.Server({port: 8080});

function removeItem<T>(arr: Array<T>, value: T): Array<T> {
    const index = arr.indexOf(value);
    if (index > -1) {
        arr.splice(index, 1);
    }
    return arr;
}

let clients: Client[] = []

server.on('connection', (socket: WebSocket) => {
    Debug.log("Got connection");

    let client = new Client(socket);

    clients.push(client);

});