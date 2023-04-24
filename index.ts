import {cert, initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import axios from 'axios';

const { RTCPeerConnection } = require('wrtc');

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

/** Global debugging level */
let DEBUG_LEVEL: number;
async function setGlobals() {
    if (process.env.ENVIRONMENT == "development"){
        NODE_INSTANCE_NAME = process.env.NODE_DEV_INSTANCE_NAME ?? "default-dev-id";
        NODE_INSTANCE_GROUP_NAME = process.env.NODE_DEV_INSTANCE_GROUP_NAME ?? "project/devgroup"
    }
    else if (process.env.ENVIRONMENT == "production"){
        let headers = {headers:{'Metadata-Flavor': 'Google'}}
        NODE_INSTANCE_NAME = (await axios.get("http://metadata.google.internal/computeMetadata/v1/instance/name", headers)).data;
        NODE_INSTANCE_GROUP_NAME = (await axios.get("http://metadata.google.internal/computeMetadata/v1/instance/attributes/created-by", headers)).data;
    }

    if (process.env.DEBUG_LEVEL) {
        if (!isNaN(parseInt(process.env.DEBUG_LEVEL))) {
            DEBUG_LEVEL = parseInt(process.env.DEBUG_LEVEL);
        }
    }
}

/** Initialise firestore */
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
     * - 9 - Signaling messages (JSON)
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

/** Creates and manages ClientConnection instances */
class ClientManager{
    protected clients: ClientConnection[];

    constructor() {
        this.clients = [];
    }

    /**
     * Gets client with id if exists
     * @param id
     */
    getClientById(id: string): ClientConnection | null{
        for(const client of this.clients){
            if(client.id == id){
                return client;
            }
        }
        return null;
    }

    /**
     * Adds client to list and initializes connection
     * @param id
     * @param initiator - Router sends offer first if true
     */
    addClient(id: string, initiator: boolean){
        let client = new ClientConnection(id, initiator);
        if(initiator){
            client.sendOffer();
        }
        this.clients.push(client);
    }

    /**
     * Removes client and closes connection, return true if successful
     * @param id
     */
    removeClient(id: string): boolean{
        let client = this.getClientById(id);
        if(client){
            client.close();
            return true;
        }
        return false;

    }
}
// Singleton
const Clients = new ClientManager()

/**
 * Manages inter-client connections
 */
class ConnectionManager{
    static connectClients(srcClientId: string, destClientIds: string[]){
        Debug.log("Routing streams", 4);
        let srcClient = Clients.getClientById(srcClientId);
        if(!srcClient){
            Debug.log(`Routing error: Source client with id ${srcClientId} does not exist`, 1);
            return;
        }
        let srcStream = srcClient.clientStreams[0];
        for (let i = 1; i < destClientIds.length; i++) {
            let destClient = Clients.getClientById(destClientIds[i]);
            if (!destClient) {
                Debug.log(`Routing error: Destination client with id ${destClientIds[i]} does not exist`, 1);
                continue;
            }
            destClient.addMediaStream(srcStream);
            destClient.renegotiateWebRTC();
        }
    }
}

/**
 * Handles client WebRTC connections
 */
class ClientConnection{
    public readonly id: string;
    public readonly isInitiator: boolean
    protected peerConnection: RTCPeerConnection;
    /** Stores a list of MediaStreams on the clients peer connection */
    public clientStreams: MediaStream[] = [];

    /** Database references */
    protected offerRef: FirebaseFirestore.CollectionReference;
    protected answerRef: FirebaseFirestore.CollectionReference;
    protected iceRef: FirebaseFirestore.CollectionReference;
    protected commandRef: FirebaseFirestore.CollectionReference;

    /**
     * Initialize client connection
     * @param {string} id - client ID
     * @param {boolean} initiator - true if client initiates connection (used for renegotiation)
     */
    constructor(id: string, initiator: boolean) {
        this.id = id;
        this.isInitiator = initiator

        this.offerRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${this.id}/receivedOffers`);
        this.answerRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${this.id}/receivedAnswers`);
        this.iceRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${this.id}/receivedIce`);
        this.commandRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${this.id}/commands`);

        // Initialize peer connection for client
        this.peerConnection = new RTCPeerConnection(wrtcConfig);

        // Add connection state logging to peer connection
        this.peerConnection.onconnectionstatechange = (ev) => {
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
     * Handle ICE from client
     * @param {RTCIceCandidate} candidate
     */
    public handleIce(candidate: RTCIceCandidate){
        Debug.log(`Got ICE from '${this.id}'`, 5);
        this.peerConnection.addIceCandidate(candidate);
    }

    /**
     * Handle WebRTC answer from client
     * @param {RTCSessionDescriptionInit} answer
     */
    public handleAnswer(answer: RTCSessionDescriptionInit){
        Debug.log(`Got answer from '${this.id}'`, 5);
        this.peerConnection.setRemoteDescription(answer);
    }

    /**
     * Handle WebRTC offer from client
     * @param {RTCSessionDescriptionInit} offer
     */
    public handleOffer(offer: RTCSessionDescriptionInit){
        Debug.log(`Got offer from '${this.id}'`, 5);
        this.getRtcAnswer(offer).then((answer) =>{
            let answerDoc = {
                id: NODE_ID,
                answer: answer
            };
            this.send(this.answerRef, answerDoc);
        });
    }

    /**
     * Send data to client over Firebase
     * @param {FirebaseFirestore.CollectionReference} dbRef - Database reference
     * @param {string} data - data to send over client socket
     * @protected
     */
    protected async send(dbRef: FirebaseFirestore.CollectionReference, data: object): Promise<void>{
        await dbRef.doc().set(data);
    }

    /**
     * Sends ICE candidates to client
     * @param candidate - ICE candidate
     * @public
     */
    public sendIce(candidate: RTCIceCandidate): void {
        let iceData = {
            src_id: NODE_ID,
            candidate: JSON.stringify(candidate)
        };
        this.send(this.iceRef, iceData);
    }

    /**
     * Sends offer to client
     */
    public async sendOffer(){
        let offer = await this.peerConnection.createOffer(wrtcOptions);
        await this.peerConnection.setLocalDescription(offer);
        let offerData = {
            id: NODE_ID,
            offer: offer
        };
        this.send(this.offerRef, offerData);
    }

    /**
     * Closes all connections to client
     */
    public close(): void{
        this.peerConnection.close();
    }

    /**
     * Renegotiates WebRTC connection with client
     */
    public renegotiateWebRTC(){
        if(this.isInitiator){
            this.sendOffer();
            return;
        }
        this.send(this.commandRef, {id: NODE_ID, command: "renegotiate"});
    }

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

    /**
     * Generates WebRTC answer from client offer
     * @param offer
     * @private
     */
    private async getRtcAnswer(offer: any): Promise<RTCSessionDescriptionInit>{
        await this.peerConnection.setRemoteDescription(offer);
        let answer = await this.peerConnection.createAnswer(wrtcOptions);
        await this.peerConnection.setLocalDescription(answer);

        return answer;
    }
}

/**
 * Manages Firebase signaling
 */
class SignalManager{
    protected offerDbRef: FirebaseFirestore.CollectionReference;
    protected answerDbRef: FirebaseFirestore.CollectionReference;
    protected iceDbRef: FirebaseFirestore.CollectionReference;
    protected commandDbRef: FirebaseFirestore.CollectionReference;

    protected unsubList: (() => void)[];
    constructor() {
        this.unsubList = [];

        let addUnsub = (unsub: ()=>void) => this.unsubList.push(unsub);

        this.offerDbRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${NODE_ID}/receivedOffers`);
        this.answerDbRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${NODE_ID}/receivedAnswers`);
        this.iceDbRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${NODE_ID}/receivedIce`);
        this.commandDbRef = db.collection(`meetings/${NODE_INSTANCE_GROUP_NAME}/clients/${NODE_ID}/commands`);

        addUnsub(this.offerDbRef.onSnapshot(this.handleOffer));
        addUnsub(this.answerDbRef.onSnapshot(this.handleAnswer));
        addUnsub(this.iceDbRef.onSnapshot(this.handleICE));
        addUnsub(this.commandDbRef.onSnapshot(this.handleCommand));
    }

    async handleOffer(snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>){
        snapshot.docChanges().forEach(change => {
            if(change.type == "added"){
                let client = Clients.getClientById(change.doc.data().id);
                if(!client){
                    Debug.log(`Got offer from client id ${change.doc.data().id} which was not initialized`, 1);
                    return;
                }
                if(change.doc.data().offer){
                    client.handleOffer(change.doc.data().offer);
                    return;
                }
                Debug.log(`Got null offer from client id ${change.doc.data().id}`, 1);

            }
        });
    }

    async handleAnswer(snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>){
        snapshot.docChanges().forEach(change => {
            if(change.type == "added"){
                let client = Clients.getClientById(change.doc.data().id);
                if(!client){
                    Debug.log(`Got answer from client id ${change.doc.data().id} which was not initialized`, 1);
                    return;
                }
                if(change.doc.data().answer){
                    client.handleAnswer(change.doc.data().offer);
                }
                Debug.log(`Got null answer from client id ${change.doc.data().id}`, 1);

            }
        });
    }

    async handleICE(snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>){
        snapshot.docChanges().forEach(change => {
            if(change.type == "added"){
                let client = Clients.getClientById(change.doc.data().id);
                if(!client){
                    Debug.log(`Got ICE from client id ${change.doc.data().id} which was not initialized`, 1);
                    return;
                }
                if(change.doc.data().ice){
                    client.handleIce(change.doc.data().offer);
                }
                Debug.log(`Got null ICE from client id ${change.doc.data().id}`, 1);
            }
        });
    }

    async handleCommand(snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>){
        snapshot.docChanges().forEach(change => {
            Debug.log("Got command snapshot", 9);
            if(change.type == "added"){
                let docData = change.doc.data()
                if(docData.command){
                    switch (docData.command){
                        case "registerClient":
                            Debug.log(`Register client id: ${docData.client_id}`, 4)
                            Clients.addClient(docData.client_id, false);
                            break;
                        case "addRoute":
                            ConnectionManager.connectClients(docData.src_client, docData.dest_clients);
                            break;
                        case "renegotiate":
                            let client = Clients.getClientById(change.doc.data().id);
                            if(!client){
                                Debug.log(`Got renegotiation for client id ${change.doc.data().id} which was not initialized`, 1);
                                break;
                            }
                            client.renegotiateWebRTC();
                            break;
                        default:
                            Debug.log("Got invalid command", 1);
                            Debug.log(JSON.stringify(change.doc.data()), 3)
                    }
                }
            }
        });
    }
}

async function startRouter(){
    Debug.log("Starting...")
    NODE_ID = NODE_INSTANCE_NAME;
    let sigManager = new SignalManager()
}

async function init(){
    await setGlobals(); // Init global vars

    let data = {
        instance_name: NODE_INSTANCE_NAME,
        instance_group_name: NODE_INSTANCE_GROUP_NAME,
        registered: false,
    };
    let newInstanceDbRef = db.collection('new-instances').where("instance_name", "==", NODE_INSTANCE_NAME)
    let docRef = db.collection('new-instances').doc(NODE_INSTANCE_NAME);

    let unsub = newInstanceDbRef.onSnapshot(async (querySnapshot) => { // Wait for management server to add connection inf
        await docRef.set(data);
        for (const change of querySnapshot.docChanges()) {
            Debug.log("Got firebase snapshot", 9);
            if(change.type == "modified" && await change.doc.data().registered){
                unsub();
                await docRef.delete();
                await startRouter();
            }
        }
    });
}

init();