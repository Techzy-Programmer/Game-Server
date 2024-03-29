import { Server } from 'ws';
import { Game } from './game';
import { Lobby } from './lobby';
import { readFileSync } from 'fs';
import { Player } from './player';
import { Utility } from './utility';
import * as admin from 'firebase-admin';
import { Level, Logger } from './logger';
import { createServer as csHttp } from 'http';
import { createServer as csHttps } from 'https';

export enum DBMode {
    WRITE,
    UPDATE,
    REMOVE
}

export abstract class Master
{
    static db: admin.database.Database; // Firebase database object reference
    static stalePlayers: Map<String, Player> = new Map(); // Players that have been disconnected or not responding
    static players: Set<Player> = new Set(); // Active players
    static games: Set<Game> = new Set(); // All active game rooms
    static pIds: number = 0;

    static async start() {
        const databaseURL = "https://db-gamerzer-default-rtdb.asia-southeast1.firebasedatabase.app";
        const baseBuff = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT, 'base64');
        const serviceAccount = JSON.parse(baseBuff.toString('utf8'));
        const credential = admin.credential.cert(serviceAccount);
        const isProd = process.env.NODE_ENV === 'production';
        admin.initializeApp({ credential, databaseURL });

        const sslCert = isProd ? {
            key: readFileSync('private.key'),
            cert: readFileSync('certificate.crt')
        } : {};

        console.log(`Running in ${isProd ? "Production" : "Development"} mode!`);
        const sslServer = isProd ? csHttps(sslCert) : csHttp();
        const port = parseInt(process.env.PORT) || 8844;
        const server = new Server({ server: sslServer });
        this.db = admin.database();

        server.on('connection', (pSock) => {
            const player = new Player(pSock, this.pIds++);
            player.on("status", this.pushStatusUpdate.bind(this));
            player.on("message", this.handleMSG.bind(this));
        });

        sslServer.listen(port);
        Logger.log(Level.INFO, "Server Started", `On Port: ${port}`);
    }

    static async dbGet(path: string, orderKey?, orderValue?): Promise<any> {
        const ref = this.db.ref(path);
        let snap: admin.database.DataSnapshot;

        if (orderKey && orderValue)
            snap = await ref.orderByChild(orderKey)
                .equalTo(orderValue).get();
        else snap = await ref.get();

        if (!snap.exists()) return null;
        else return snap.val();
    }

    static async dbSet(mode: DBMode, path: string, data: any = null) {
        const dref = this.db.ref(path);

        switch (mode) {
            case DBMode.WRITE:
                await dref.set(data);
                break;

            case DBMode.UPDATE:
                await dref.update(data);
                break;

            case DBMode.REMOVE:
                await dref.remove();
                break;
        }
    }

    // Sends message of a given type and data to a subset of players based on the third parameter.
    static broadcast(type: string, data: any, check?: Player | Function) {
        const isFunc = check instanceof Function;

        for (const plr of this.players) {
            // The optional 'check' parameter is used to determine which players should receive the message.
            // If check is undefined, null, or any falsy value, the message will be sent to all players.
            const proceed = !check || (isFunc ? check(plr) : check !== plr);
            if (proceed) plr.send(type, data);
        }
    }

    private static tryRespawn(p: Player, name: string, eref: string, queue?: object): boolean {
        if (!this.stalePlayers.has(eref)) return false;
        const respPlr = this.stalePlayers.get(eref);
        this.stalePlayers.delete(eref);
        respPlr.switchState(p.sock);
        respPlr.postAuth(name, eref,
            queue, true);
        respPlr.id = p.id;
        p.switchState();
        p.id = -1;
        return true;
    }

    private static async handleMSG(plr: Player, msg: any) {
        const data = msg.data;

        switch (msg.type) {
            case "Login": { // ToDo: add logic to revive disconnected player
                let emDbRefLog = 'null';

                if (data.sess && typeof data.sess == 'string') {
                    const qryData = await this.dbGet('users', 'session', data.sess);
                    if (qryData) {
                        const dref = Object.keys(qryData)[0];
                        const userDObj = qryData[dref];

                        if (parseInt(userDObj.session.split('|')[1]) > Date.now()) {
                            if (!userDObj.isBlocked) {
                                if (!this.tryRespawn(plr, userDObj.name, dref, data.queue))
                                    plr.postAuth(userDObj.name, dref, data.queue);
                            }
                            else plr.send('Warn', "Your are blocked by admin", true);
                            return;
                        }
                    }

                    plr.send('Warn', "Session expired! login again", true);
                    return;
                }

                if (typeof data.email == 'string') {
                    data.email = data.email.toLowerCase();
                    emDbRefLog = Utility.hash(data.email, 'md5');
                }

                const userDet = await this.dbGet(`users/${emDbRefLog}`);
                if (userDet !== null) { // Okay user already registered!
                    if (userDet.pass === Utility.hash(data.pass)) { // Authenticate password
                        if (!userDet.isBlocked) { // Authentication passed
                            if (!this.tryRespawn(plr, userDet.name, emDbRefLog, data.queue)) // Let's respawn player if connected already earlier
                                plr.postAuth(userDet.name, emDbRefLog, data.queue); // Else normal login
                        }
                        else plr.send('Warn', "Your are blocked by admin", true);
                    }
                    else plr.send('Error', "Oh! It's wrong login password.", true);
                    return;
                }

                plr.send('Error', "Please register first to continue", true);
                break;
            }

            case "Register": {
                if (await this.dbGet('regAccessCode') == data.access) {
                    if (!data.name || !data.email || !data.pass || typeof data.name !== 'string'
                        || typeof data.email !== 'string' || typeof data.pass !== 'string') {
                        plr.send('Error', "Invalid or Malformed request.", true);
                        return;
                    }

                    if (data.name.length < 4) {
                        plr.send('Error', "Name is too short, it should be at least 4 characters long.", true);
                        return;
                    }

                    if (data.name.length > 20) {
                        plr.send('Error', "Name is too long, it must not exceed 20 characters.", true);
                        return;
                    }

                    if (!Utility.isValidPassword(data.pass)) {
                        plr.send('Error', "Password should be alphanumeric, with at least 8 characters, including special characters.", true);
                        return;
                    }

                    if (!data.email || !Utility.isValidEmail(data.email)) {
                        plr.send('Error', "This email doesn't looks like a valid one, try again.", true);
                        return;
                    }

                    data.name = data.name.trim();
                    data.email = data.email.trim();
                    data.email = data.email.toLowerCase();
                    const emDbRefSig = Utility.hash(data.email, 'md5');

                    if (await this.dbGet(`users/${emDbRefSig}`) !== null) {
                        plr.send('Error', "User already exists! Please login to continue.", true);
                        return;
                    }

                    await this.dbSet(DBMode.WRITE, `users/${emDbRefSig}`, { // Save user's data to db
                        pass: Utility.hash(data.pass),
                        email: data.email,
                        name: data.name,
                        isBlocked: false
                    });

                    this.randomizeAccess(); // Generate and save new access code so that new user can't register directly with same access code
                    plr.postAuth(data.name, emDbRefSig); // Registration complete
                    return
                }

                plr.send('Error', "Access code is invalid!", true);
                break;
            }

            case "Logout":
                await Master.dbSet(DBMode.UPDATE, `users/${plr.dbRef}`, { session: 'null|0' });
                plr.fireDisconnection(true);
                break;

            case "Search": // Match-Making starts
                if (Lobby.addFinder(plr, data.gameId, data.plrCount))
                    plr.send("Goto-Lobby");
                else plr.send("Lobby-Cancel");
                break;

            case "Cancel-Search": // Match-Making aborted
                plr.send("Search-Cancelled");
                Lobby.removeFinder(plr);
                break;

            default: // Hmmm... something suspicious
                plr.send("Error", "Invalid request!");
                break;
        }
    }

    // Randomize access code everytime server restarts or new user registers
    private static async randomizeAccess() { // While signing up user must provide right access code
        const code = parseInt(`${Math.random() * (999999 - 100000) + 100000}`);
        await this.dbSet(DBMode.WRITE, 'regAccessCode', code);
    }

    private static pushStatusUpdate(exPlr: Player) {
        this.broadcast('Status-Update', { // Inform every other player about 'exPlr' new status
            status: exPlr.status,
            id: exPlr.dbRef
        }, exPlr);
    }
}
