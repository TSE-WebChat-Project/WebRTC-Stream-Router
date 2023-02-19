import {WebSocketServer} from "ws";

const { RTCPeerConnection } = require('wrtc');
const Socket = require("ws");
const wrtcConfig = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]}
const wrtcOptions = {offerToReceiveAudio: true, offerToReceiveVideo: true}

let NODE_ID: string = "default";
let NODE_AUTH: string = "testauth";

// Debug messages
class Debug{
    static debugLevel: number = 4
    static log(msg: string, level: number = 3): void{
        if(this.debugLevel >= level){
            console.log(msg);
        }
    }
}

// WEB SOCKET COMMUNICATION STANDARD
//
// action: "<verb>"
// data: <data>
// id: "<id>"
// token: "<token>"
//




// Handle socket request parsing
class Request{
    public readonly parseError: boolean = false;
    public readonly action: string;
    public readonly data: any = null;
    public readonly id: string;
    public readonly token: string;

    constructor(msg: MessageEvent) {
        Debug.log(msg.data, 4);
        let parsed;
        try{
            parsed = JSON.parse(msg.data);
        }
        catch (SyntaxError){
            this.parseError = true;
        }

        this.action = parsed.action ?? "";
        this.data = parsed.data ?? null;
        this.id = parsed.id ?? "";
        this.token = parsed.token ?? "";

    }
}

// Generate socket responses
class Response {
    // static INVALID_REQUEST: string = JSON.stringify({action: "", error: true});
    // static AUTH_FAILED: string = JSON.stringify({message: "Invalid auth", "error": true});
    // static RENEGOTIATE_RTC: string = JSON.stringify({message: "renegotiate", renegotiate: true, error: false});

    static generateGenericMessage(action: string, data: any, id: string, token: string): string{
        return JSON.stringify({action: action, data: data, id: id, token: token});
    }

    static generateOfferMessage(offer: any): string{
        return Response.generateGenericMessage("offer", offer, NODE_ID, NODE_AUTH);
    }

    static generateAnswerMessage(answer: any): string{
        return Response.generateGenericMessage("answer", answer, NODE_ID, NODE_AUTH);
    }

    static generateRenegotiateMessage(){
        return Response.generateGenericMessage("renegotiate", null, NODE_ID, NODE_AUTH);
    }

    static generateIceMessage(candidate: RTCIceCandidate): string{
        return Response.generateGenericMessage("addICE", candidate, NODE_ID, NODE_AUTH);
    }
}

// Stores information about the client
class Client {
    private id_: string|null = null;
    private socket: WebSocket;
    private peerConnection: RTCPeerConnection;
    private clientStream: MediaStream|null = null;
    private isAdmin: boolean = false;
    private isInitiator: boolean = false;

    constructor(socket: WebSocket) {
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
        if(this.isInitiator){
            this.sendOffer();
            return;
        }
        this.socket.send(Response.generateRenegotiateMessage());
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

        if (req.parseError) {
            // this.socketSend(Response.INVALID_REQUEST);
            // this.close();
            return;
        }

        // Authenticate
        if (!this.getAuthentication(req)) {
            Debug.log("Auth failed", 4);
            // this.socketSend(Response.AUTH_FAILED);
            this.socket.close();
            this.peerConnection.close();
            return;
        }

        if(this.isAdmin){ // Process admin control commands
            this.adminCommands(req);
            return;
        }

        switch (req.action) {
            case "offer":
                Debug.log("Offer", 5);
                this.sendAnswer(req.data);
                break;
            case "answer":
                this.processAnswer(req.data);
                break;
            case "renegotiate":
                this.sendOffer();
                break;
            case "addICE":
                Debug.log("ICE", 5);
                if(req.data.candidate){
                    this.peerConnection.addIceCandidate(req.data);
                }
                break;
        }
    }
    
    private adminCommands(req: Request){
        Debug.log("Admin command", 5);
        if(!NODE_ID){
            return;
        }
        switch (req.action){
            case "setId":
                NODE_ID = req.data;
                break;
            case "addRoute": // Connect a source users stream to other users
                Debug.log("Routing streams", 4);
                // @ts-ignore
                let srcStream = getClientById(req.data[0]).mediaStream;
                for (let i = 1; i < req.data.length; i++) {
                    let user = getClientById(req.data[i]);
                    if(!user){Debug.log("No such user " + req.data[i]);}
                    // @ts-ignore
                    user.addMediaStream(srcStream);
                    // @ts-ignore
                    user.renegotiateWebRTC();
                }
                break;
            case "delRoute":
                break;
            case "connect":
                break;

                // Todo: Add redistribution logic
        }
    }

    private async processAnswer(answer: any){
        await this.peerConnection.setRemoteDescription(answer);
    }

    private async sendAnswer(offer: any){
        await this.peerConnection.setRemoteDescription(offer);
        let answer = await this.peerConnection.createAnswer(wrtcOptions);
        await this.peerConnection.setLocalDescription(answer);

        this.socketSend(Response.generateAnswerMessage(answer));
    }

    private async sendOffer(){
        this.isInitiator = true;
        let offer = await this.peerConnection.createOffer(wrtcOptions);
        await this.peerConnection.setLocalDescription(offer);

        this.socketSend(Response.generateOfferMessage(offer));
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