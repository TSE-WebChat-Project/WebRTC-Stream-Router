import {WebSocketServer} from "ws";
import {cert, initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import axios from 'axios';

const { RTCPeerConnection } = require('wrtc');
const Socket = require("ws");

/** WebRTC connection config */
const wrtcConfig = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]};
/** WebRTC connection options. Allows adding video and audio streams after init */
const wrtcOptions = {offerToReceiveAudio: true, offerToReceiveVideo: true};

/** Node id */
let NODE_ID: string;
/** Node instance name */
let NODE_INSTANCE_NAME: string;
/** Node instance group name */
let NODE_INSTANCE_GROUP_NAME: string;
/** Node socket address */
let NODE_SOCKET_ADDRESS: string;
/** Node socket port */
let NODE_SOCKET_PORT: string;
/** Node auth token */
let NODE_AUTH: string;

/** Global debugging level */
let DEBUG_LEVEL: number;

async function setGlobals() {
    if (process.env.ENVIRONMENT == "development"){
        NODE_INSTANCE_NAME = process.env.NODE_DEV_INSTANCE_NAME ?? "default-dev-id";
        NODE_SOCKET_ADDRESS = process.env.NODE_DEV_SOCKET_ADDRESS ?? "ws://localhost:8080";
        NODE_SOCKET_PORT = process.env.NODE_DEV_SOCKET_PORT ?? "8080"
        NODE_INSTANCE_GROUP_NAME = process.env.NODE_DEV_INSTANCE_GROUP_NAME ?? "project/devgroup"
    }
    else if (process.env.ENVIRONMENT == "production"){
        let headers = {headers:{'Metadata-Flavor': 'Google'}}
        NODE_INSTANCE_NAME = await axios.get("http://metadata.google.internal/computeMetadata/v1/instance/name", headers);
        NODE_SOCKET_ADDRESS = await axios.get("http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip", headers)
        NODE_INSTANCE_GROUP_NAME = await axios.get("http://metadata.google.internal/computeMetadata/v1/instance/attributes/created-by", headers);
    }
    NODE_AUTH= '';

    if (process.env.DEBUG_LEVEL) {
        if (!isNaN(parseInt(process.env.DEBUG_LEVEL))) {
            DEBUG_LEVEL = parseInt(process.env.DEBUG_LEVEL);
        }
    }
}

class Debug{
    static debugLevel: number = 4;

    /** Used for logging and debugging. Will log messages to console when param level is
     *  greater or equal to the global variable DEBUG_LEVEL. Default value is 4.
     *
     *
     * Levels guide:
     * - 0 - Nothing
     * - 1 - Errors
     * - 2 - State messages
     * - 3 - Admin/Routing
     * - 4 - Connections/Disconnects
     * - 5 - WebRTC Offer Answer
     * - 6 - WebRTC track
     * - 7 - WebRTC ICE
     * - 8 - Unused
     * - 9 - Socket messages (JSON)
     * - 10+ - Everything
     * @param msg - the message to be logged
     * @param level - the debugging level at which the message will be shown
     */
    static log(msg: string, level: number = 3): void{
        if((DEBUG_LEVEL ?? this.debugLevel) >= level && level != 0){
            let now = new Date(Date.now());
            console.log(`[${now.toUTCString()}] ${msg}`);
        }
    }
}


/**
 * Parses websocket requests
 *
 *
 * ### Websocket communication standard
 * Initiator:
 * ```
 * {action: "<verb>",
 * data: <data>,
 * id: "<id>",
 * token: "<token>"}
 * ```
 * Receiver:
 * ```
 * {action: "<verb>",
 * data: "<data>"}
 * ```
 *
 * Initiator always authenticates with receiver, not the other way around
 */
class SockRequest{
    /** False by default, true if an error is encountered while parsing a message */
    public readonly parseError: boolean = false;
    public readonly action: string;
    public readonly data: any = null;
    public readonly id: string;
    public readonly token: string;

    /**
     * Initializes a SockRequest object from a websocket MessageEvent
     * @param {MessageEvent} msg - websocket message to be parsed
     */
    constructor(msg: MessageEvent) {
        Debug.log("Socket message: " + msg.data, 9);
        // let parsed = JSON.parse('{action: null, data: null, id: null, token: null}');
        let parsed;
        try{ // Try to parse message
            parsed = JSON.parse(msg.data);
        }
        catch (SyntaxError){
            this.parseError = true;
            Debug.log("Could not parse message");
        }

        // Set props to value or default
        this.action = parsed.action ?? "";
        this.data = parsed.data ?? null;
        this.id = parsed.id ?? "";
        this.token = parsed.token ?? "";
    }
}

/**
 * Generates Socket responses
 */
class SockResponse{
    static RESP_OFFER = (offer: RTCSessionDescriptionInit): string =>
    {return SockResponse.generateGenericMessage("offer", offer, NODE_INSTANCE_NAME, NODE_AUTH, true);}

    static RESP_ANSWER = (ans: RTCSessionDescriptionInit): string =>
    {return SockResponse.generateGenericMessage("answer", ans, NODE_INSTANCE_NAME, NODE_AUTH, false);}

    static RESP_RENEG = (): string =>
    {return SockResponse.generateGenericMessage("renegotiate", null, NODE_INSTANCE_NAME, NODE_AUTH, false);}

    static RESP_ICE = (ice: RTCIceCandidate, auth: boolean): string =>
    {return SockResponse.generateGenericMessage("addICE", ice, NODE_INSTANCE_NAME, NODE_AUTH, auth);}

    /** Generates message in correct format. For internal use only.
     * **Do not use outside class**, add static *RESP_<type>* to class instead
     */
    static generateGenericMessage(action: string, data: any, id: string,
                                  token: string, useAuth:boolean = false): string{
        if(useAuth){
            return JSON.stringify({action: action, data: data, id: id, token: token});
        }
        return JSON.stringify({action: action, data: data});
    }
}


/**
 * Manages connections for WebRTC clients
 */
abstract class ClientConnection{
    private _id: string | null = null;
    private socket: WebSocket;
    protected peerConnection: RTCPeerConnection;
    /** Stores a list of MediaStreams on the clients peer connection */
    clientStreams: MediaStream[] = [];

    get id(): string{
        return this._id ?? "";
    }

    /**
     * Initialize client connection from websocket
     * @param {WebSocket} socket - client WebSocket connection
     */
    constructor(socket: WebSocket) {
        this.socket = socket;
        this.socket.onmessage = (msg: MessageEvent) => {
            this.onClientMessage(msg);
        }
        // Initialize peer connection for client
        this.peerConnection = new RTCPeerConnection(wrtcConfig);

        // Add connection state logging to peer connection
        this.peerConnection.onconnectionstatechange = () => {
            switch (this.peerConnection.connectionState) {
                case "connected":
                    Debug.log("WebRTC connection established", 4);
                    break;
                case "disconnected":
                    Debug.log("WebRTC connection lost", 4);
                    break;
            }
        };

        // Add tracks to clientStreams when they become available
        // TODO: Add and remove multiple MediaStream tracks
        this.peerConnection.ontrack = async (event) => {
            Debug.log("Got track", 6);
            this.clientStreams.push(event.streams[0]);
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

    /**
     * Authenticates connection with id and token in SockRequest object
     * @param {SockRequest} req - request to authenticate
     * @protected
     * @returns boolean
     */
    protected authenticateRequest(req: SockRequest): boolean{
        if(this._id == null){ // Assign id to connection on first auth
            this._id = req.id;
        }
        else if (this._id != req.id){ // Check if id changed since first auth
            return false;
        }
        if(req.token == "testauth"){ // ToDo: implement authentication (firebase)
            Debug.log("Authenticated user" + this._id, 4);
            return true;
        }
        return false;
    }

    /**
     * Send data to client over the websocket connection
     * @param {string} data - data to send over client socket
     * @protected
     */
    protected send(data: string): void{
        this.socket.send(data);
    }

    /**
     * Closes all connections to client
     */
    public close(): void{
        this.peerConnection.close();
        this.socket.close();
    }

    /**
     * Renegotiates WebRTC connection with client
     * @protected
     */
    abstract renegotiateWebRTC(): void;

    /**
     * Sends ICE candidates over websocket to client
     * @param candidate - ICE candidate
     * @protected
     */
    protected abstract sendIce(candidate: RTCIceCandidate): void


    /**
     * Callback for Websocket message event
     * @param {MessageEvent} msg - message
     * @protected
     */
    protected abstract onClientMessage(msg: MessageEvent): void;

    /**
     * Adds MediaStream object to client
     * @param stream
     */
    public addMediaStream(stream: MediaStream): void {
        stream.getTracks().forEach(track => {
            Debug.log("Adding media track to user" + this.id, 4);
            this.peerConnection.addTrack(track, stream);
        });
    }
}

class InboundClient extends ClientConnection{
    /** @inheritDoc */
    protected onClientMessage(msg: MessageEvent): void {
        let req = new SockRequest(msg);
        if (req.parseError) {
            Debug.log("Could not parse message from client", 4);
            return;
        }

        if (!this.authenticateRequest(req)) {
            Debug.log("Auth failed", 4);
            this.close();
            return;
        }

        switch (req.action) {
            case "offer":
                Debug.log(`Got offer from '${this.id}'`, 5);
                this.getRtcAnswer(req.data).then((answer) =>{
                    this.send(SockResponse.RESP_ANSWER(answer));
                });
                break;
            case "addICE":
                Debug.log(`Got ICE from '${this.id}'`, 5);
                if(req.data.candidate){
                    this.peerConnection.addIceCandidate(req.data);
                }
                break;
            default:
                Debug.log(`Unknown command '${req.action}' from client ${this.id}`, 5);
        }
    }

    /** @inheritDoc */
    public renegotiateWebRTC(): void {
        this.send(SockResponse.RESP_RENEG());
    }

    /**
     * Generate answer for WebRTC offer
     * @param offer
     * @private
     */
    private async getRtcAnswer(offer: any): Promise<RTCSessionDescriptionInit>{
        await this.peerConnection.setRemoteDescription(offer);
        let answer = await this.peerConnection.createAnswer(wrtcOptions);
        await this.peerConnection.setLocalDescription(answer);

        return answer;
    }

    /** @inheritDoc */
    protected sendIce(candidate: RTCIceCandidate): void {
        this.send(SockResponse.RESP_ICE(candidate, false));
    }
}

class OutboundClient extends ClientConnection{
    /** @inheritDoc */
    onClientMessage(msg: MessageEvent): void {
        let req = new SockRequest(msg);
        if (req.parseError) {
            Debug.log("Could not parse message from client", 4);
            return;
        }

        switch (req.action) {
            case "answer":
                this.processAnswer(req.data);
                break;
            case "renegotiate":
                this.renegotiateWebRTC();
                break;
            case "addICE":
                Debug.log(`Got ICE from '${this.id}'`, 5);
                if(req.data.candidate){
                    this.peerConnection.addIceCandidate(req.data);
                }
                break;
            default:
                Debug.log(`Unknown command '${req.action}' from client ${this.id}`, 5);
        }
    }

    /**
     * Handle received WebRTC answer response
     * @param answer
     * @private
     */
    private async processAnswer(answer: any){
        await this.peerConnection.setRemoteDescription(answer);
    }

    /**
     * Sends WebRTC offer to client
     * @private
     */
    private async sendOffer(){
        let offer = await this.peerConnection.createOffer(wrtcOptions);
        await this.peerConnection.setLocalDescription(offer);
        this.send(SockResponse.RESP_OFFER(offer));
    }

    /** @inheritDoc */
    renegotiateWebRTC(): void {
        this.sendOffer();
    }

    /** @inheritDoc */
    protected sendIce(candidate: RTCIceCandidate): void {
        this.send(SockResponse.RESP_ICE(candidate, true));
    }

}

/**
 * Handles management websocket interface
 */
class Management{
    private socket: WebSocket;
    protected clients: ClientConnection[]; // List of all connected clients
    constructor(socket: WebSocket) {
        this.socket = socket;
        this.socket.onmessage = (event: MessageEvent) => {
            this.onManagementMessage(event);
        }
        this.clients = [];
    }

    protected onManagementMessage(msg: MessageEvent): void{
        let req = new SockRequest(msg);
        if (req.parseError) {
            Debug.log("Could not parse message from management server", 1);
            return;
        }

        switch (req.action) {
            case "setId":
                NODE_ID = req.data;
                Debug.log(`Node id set by management server. ID: ${NODE_ID}`);
                break;
            case "addRoute": // Connect a source users stream to other users
                Debug.log("Routing streams", 4);
                let client = this.getClientById(req.data[0]);
                if (!client){
                    Debug.log(`Routing error: Source client with id ${req.data[0]} does not exist`, 1);
                    break;
                }
                let srcStream = client.clientStreams[0];
                for (let i = 1; i < req.data.length; i++) {
                    let user = this.getClientById(req.data[i]);
                    if (!user) {
                        Debug.log(`Routing error: Destination client with id ${req.data[i]} does not exist`, 1);
                        continue;
                    }
                    user.addMediaStream(srcStream);
                    user.renegotiateWebRTC();
                }
                break;
            case "connect": // Connect to another node
                let interSock = new Socket(req.data);
                let interClient = new OutboundClient(interSock);
                this.clients.push(interClient);
                interSock.onopen = () => {
                    interClient.renegotiateWebRTC();
                }
                break;
        }
    }

    /**
     * Gets client with by id
     * @param id
     * @returns ClientConnection or null if client not found
     */
    public getClientById(id: string): ClientConnection|null {
        let result: ClientConnection | null = null;
        this.clients.forEach((client) => {
            if (client.id === id) {
                result = client;
            }
        });

        return result;
    }

    /**
     * Adds a client connection to the manager
     * @param client
     */
    public addClient(client: ClientConnection): void{
        this.clients.push(client);
    }
}

Debug.log("Start", 1)

// Initialise firestore
if(process.env.ENVIRONMENT == "development"){ // Use service key in development environment
    if(!process.env.SERVICE_KEY){
        throw new Error("Environment set to development but no service key set!")
    }
    const serviceAccount = require(process.env.SERVICE_KEY);
    initializeApp({
        credential: cert(serviceAccount)
    });
}
else if(process.env.ENVIRONMENT == "production"){
    initializeApp();
}

const db = getFirestore();


async function init(){
    await setGlobals(); // Init global vars

    let data = {
        instance_name: NODE_INSTANCE_NAME,
        instance_group_name: NODE_INSTANCE_GROUP_NAME,
        management_socket: null,
        socket_address: NODE_SOCKET_ADDRESS,
        socket_port: NODE_SOCKET_PORT
    };
    let docRef = db.collection('new-instances').doc("instance-name-test")
    await docRef.set(data);

    let db_read = false; // Used to stop event firing multiple times
    let unsub = docRef.onSnapshot(async (snapshot: any) => { // Wait for management server to add connection info
        Debug.log("Got firebase snapshot", 9);
        if(db_read){return;}

        data = await snapshot.data()
        if (data.management_socket){
            db_read = true;
            Debug.log(`Got management socket from firestore: ${data.management_socket}`, 2);

            // Start server
            const managementSocket: WebSocket = new Socket(data.management_socket);
            const manager = new Management(managementSocket);

            const server: WebSocketServer = new Socket.Server({port: 8081});

            server.on('connection', (socket: WebSocket) => {
                Debug.log("Got connection", 3);
                let client = new InboundClient(socket);
                manager.addClient(client);
                // TODO: Handle disconnect
            });

            await docRef.delete();
            unsub(); // Remove event listener
            Debug.log("Connection document deleted", 2);
        }
    });
}

init().then(() => {Debug.log("Setup complete")});
