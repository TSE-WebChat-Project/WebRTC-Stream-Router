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
    static INVALID_REQUEST: string = JSON.stringify({command: "", error: true});
    static AUTH_FAILED: string = JSON.stringify({message: "Invalid auth", "error": true});
    static RENEGOTIATE_RTC: string = JSON.stringify({message: "renegotiate", renegotiate: true, error: false});

    static generateAnswerResponse(answer: any){
        return JSON.stringify({message: "SDP answer", "sdp": answer, error: false})
    }

    static generateIceMessage(candidate: RTCIceCandidate){
        return JSON.stringify({message: "New ICE Candidate", candidate: candidate, error: false})
    }
}

// Stores information about the client
class Client {
    private id_: string|null = null;
    private socket: WebSocket;
    private peerConnection: RTCPeerConnection;
    private clientStream: MediaStream|null;
    private isAdmin: boolean = false;

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

        this.peerConnection.ontrack = async (event) => {
            Debug.log("Got track", 5);
            [this.clientStream] = event.streams;
        };

        this.peerConnection.onicecandidate = event => {
            // Check if the event has a candidate property
            if (event.candidate) {
                Debug.log("Sending ICE", 5);
                // Send the ICE candidate to the receiver over a signaling channel
                this.sendIce(event.candidate);
            }
        };
    }

    get id(){
        return this.id_
    }

    get mediaStream(){
        return this.clientStream;
    }

    public addMediaStream(stream: MediaStream){
        stream.getTracks().forEach(track => {
            Debug.log("Adding media track to user" + this.id_, 4);
            this.peerConnection.addTrack(track, stream);
        });
    }

    public renegotiateWebRTC(){
        this.socket.send(Response.RENEGOTIATE_RTC);
    }

    private getAuthentication(req: Request){
        if(this.id_ == null){
            this.id_ = req.id;
        }
        else if (this.id_ != req.id){
            return false;
        }

        if(req.id === "admin"){
            this.isAdmin = true;
        }

        if(req.token == "testauth"){ // ToDo: implement authentication
            Debug.log("Authenticated user" + this.id_, 4);
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
            this.peerConnection.close();
            return;
        }

        if(this.isAdmin){ // Process admin control commands
            this.adminCommands(req);
            return;
        }

        switch (req.command) {
            case "offer":
                Debug.log("Offer", 5);
                this.processOffer(req.data);
                break;
            case "iceCandidate":
                Debug.log("ICE", 5);
                if(req.data.candidate){
                    this.peerConnection.addIceCandidate(req.data);
                }
                break;
        }
    }
    
    private adminCommands(req: Request){
        Debug.log("Admin command", 5);
        switch (req.command){
            case "connect": // Connect a source users stream to other users
                Debug.log("Connecting streams", 4);
                let srcStream = getClientById(req.data[0]).mediaStream;
                for (let i = 1; i < req.data.length; i++) {
                    let user = getClientById(req.data[i]);
                    if(!user){Debug.log("No such user " + req.data[i]);}
                    user.addMediaStream(srcStream);
                    user.renegotiateWebRTC();
                }
                break;
            case "disconnect":
                break;
                // Todo: Add redistribution logic
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

let clients: Client[] = [];

function getClientById(id: string): Client|null{
    let result: Client|null = null;
    clients.forEach((client) => {
        if(client.id === id){
            result = client;
        }
    });

    return result;
}

server.on('connection', (socket: WebSocket) => {
    Debug.log("Got connection", 3);

    let client = new Client(socket);

    clients.push(client);
    
    socket.onclose = () => { // Remove client from list on disconnect
        removeItem(clients, client);
    };
    

});