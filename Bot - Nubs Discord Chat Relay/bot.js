// This simple bot will allow discord messages to appear in your Garry's Mod server,
// as well as the server chat to appear in a Discord channel.

// You may notice I only require the functions I actually use. That's because Discord has made it so you have to specify
// exactly what you need/are doing with your bot. So I said fuck it and I might as well do that with everything :^) 

// We need this to read and write the config file, and the connection log
const { readFileSync, writeFile, appendFile, writeFileSync, existsSync, unlink } = require('fs');

// Allows for the gmod server and the bot to communicate
// At the time of writing this, I'm running ws version 8.5.0
const { WebSocketServer } = require('ws');

// Making a bot (duh)
// At the time of making this, I'm running discord.js version 14.11.0
const { Client, GatewayIntentBits, User, GuildMember } = require('discord.js'); 

// We use http.get to get Steam avatars. If you don't want avatars, you can comment this out and not install axios from npm.
// At the time of making this, I'm running axios version 1.4.0
const { get } = require('axios');

const Rcon = require("rcon");

let config = require("./config.js");
let webhookData = JSON.parse(readFileSync("./ids.json"));

function parseStatusData(input) {
    const lines = input.trim().split('\n');
    let hostname = '';
    let map = '';
    let playersInfo = [];
    let activePlayers = [];
    let spawningPlayers = [];

    lines.forEach(line => {
        if (line.startsWith('hostname:')) {
            hostname = line.split('hostname:')[1].trim();
        } else if (line.startsWith('map')) {
            // Correctly extract the map name
            map = line.split('map     :')[1].trim().split(' ')[0];
        } else if (line.startsWith('players')) {
            playersInfo = line.split('players :')[1].trim().match(/\d+/g);
        } else if (line.startsWith('#')) {
            const playerInfo = line.trim().split(/\s+/);
            const name = playerInfo.slice(2, playerInfo.length - 5).join(' ').replace(/"/g, '');
            const steamID = playerInfo[playerInfo.length - 5];
            const timeConnected = playerInfo[playerInfo.length - 4];
            const status = playerInfo[playerInfo.length - 1];
            const playerData = [name, steamID, timeConnected, status];

            if (status === 'active') {
                activePlayers.push(playerData);
            } else if (status === 'spawning') {
                spawningPlayers.push(playerData);
            }
        }
    });

    const numPlayers = playersInfo ? parseInt(playersInfo[0], 10) : 0;

    return {
        hostname,
        map,
        numPlayers,
        activePlayers,
        spawningPlayers
    };
}


function sendCommand(command, id) {
	console.log(id)
    return new Promise((resolve, reject) => {
        const rcon = new Rcon(config.ServerRcons[id].ip, config.ServerRcons[id].port, config.ServerRcons[id].password);

        let fullResponse = '';

        rcon.on('auth', () => {
            rcon.send(command);
        });

        rcon.on('response', (response) => {
            fullResponse += response;
			setTimeout(() => {
				rcon.disconnect();
			}, 500);
        });

        rcon.on('end', () => {
            if (fullResponse) {
                resolve(fullResponse); 
            } else {
                reject(new Error('No response received from server'));
            }
        });

        rcon.on('error', (err) => {
            reject(err);
        });

        rcon.connect();
    });
}

// Constants
const wss = new WebSocketServer({host: '0.0.0.0', port: config.PortNumber}); // We set the host to '0.0.0.0' to tell the server we want to run IPv4 instead of IPv6
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildWebhooks, 
        GatewayIntentBits.MessageContent
    ]
});

if (config.DiscordUsernameFix) {
    // This is not a recommended thing to do, but since discord.js doesn't 
    // appear to be supporting the new username system any time soon, here's my own crude fix.
    // This will allow user global names to appear, as well as GuildMember.displayName showing it

    User.prototype.__Relay_InjectPatch = User.prototype._patch;
    User.prototype._patch = function (data) {
        this.__Relay_InjectPatch(data);

        if ('global_name' in data) {
            this.globalName = data.global_name;
        } else {
            this.globalName ??= null;
        }
    }
    Object.defineProperty(User.prototype, "displayName", {
        get: function displayName() {return this.globalName ?? this.username;}
    });

    Object.defineProperty(GuildMember.prototype, "displayName", {
        get: function displayName() {return this.nickname ?? this.user.displayName;}
    });
}


// logConnection - Called when someone attempts to connect to the websocket server. Logs it to ./connection_log.txt
function logConnection(ip, status) {
    let date = new Date();
    let timestamp = `[${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} @ ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}]`;

    let message = `\n${timestamp} ${status ? 'Accepting' : 'Denying'} websocket connection request from ${ip}`;

    console.log(message);

    if (config.LogConnections) 
        appendFile('./connection_log.txt', message, err => {if (err) console.err(err);});
}

// assignWebhook takes a webhook object and stores it for later
function assignWebhook(wh) {
    webhook = wh; 
    webhookData.Webhook.ID = webhook.id;
    webhookData.Webhook.Token = webhook.token;
}

function saveIds() {
    writeFile("./ids.json", JSON.stringify(webhookData, null, 4), err => {if (err) console.error(err);});
}

// getSteamAvatar checks the avatar cache and refreshes them when needed.
let avatarCache = {};
async function getSteamAvatar(id) {
    if (config.SteamAPIKey.length === 0  || id == 0) // If there is no API key specified, they must not want avatars.
        return;

    let needsRefresh = false;
    if (avatarCache[id]) {
        if (Date.now() - avatarCache[id].lastFetched >= config.SteamAvatarRefreshTime * 60000) {
            needsRefresh = true;
        }
    } else {
        needsRefresh = true;
    }

    if (needsRefresh) {
        let res = await get(`http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.SteamAPIKey}&steamids=${id}`);
        avatarCache[id] = {
            avatar: res.data.response.players[0].avatarfull,
            lastFetched: Date.now()
        };
    }
}

// I use a queueing system to stack up messages to be sent through the webhook. I wait for the previous webhook to send just in case they try to send out of order.
let queue = [];
let runningQueue = false;
let replyInteraction;
let statusTimeout = [];
async function sendQueue(ws) {
    if (!webhook || runningQueue)
        return; 

    runningQueue = true;

    for (let i = 0; i < queue.length; i++) {
        let packet = queue[i];
        switch (packet.type) {
            case "message": {
                if (packet.content.length > 0) {
                    let opts = {
                        content: packet.content,
                        username: packet.from
                    }
                    
                    await getSteamAvatar(packet.fromSteamID);
                    if (avatarCache[packet.fromSteamID]) 
                        opts.avatarURL = avatarCache[packet.fromSteamID].avatar;
                    
                    await webhook.send(opts);
                }
            } break;

            case "join/leave": {
                let options = {
                    username: "Player Connection Status"
                }
                // 1 = join, 2 = spawn, 3 = leave
                switch (packet.messagetype) {
                    case 1: {
                        options.content = `${packet.username} (${packet.usersteamid}) has connected to the server.`;
                    } break;

                    case 2: {
                        let spawnText = '';

                        if (packet.userjointime) {
                            let spawnTime = Math.round(Date.now()/1000) - packet.userjointime;
                            let minutes = Math.floor(spawnTime / 60);
                            let seconds = spawnTime % 60;
                            spawnText = ` (took ${minutes}:${seconds < 10 ? `0${seconds}` : seconds})`;
                        }

                        options.content = `${packet.username} (${packet.usersteamid}) has spawned into the server${spawnText}.`
                    } break;

                    case 3: {
                        options.content = `${packet.username} (${packet.usersteamid}) has left the server (${packet.reason}).`
                    } break;
                }

                await webhook.send(options);
            } break;

            case "status": {
				if (!replyInteraction) return;
				if (statusTimeout){
					clearTimeout(statusTimeout[ws.id]);
				};

				let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

				let maxNameLength    = name.length;
				let maxSteamidLength = steamid.length;
				let maxJoinTimestamp = joined.length;
				let maxStatus        = status.length;

				let rows = [];

				let now = Math.round(Date.now() / 1000);
				for (let i = 0; i < packet.connectingPlayers.length; i++) {
					let data = packet.connectingPlayers[i];

					let timeString = 'Unknown';
					if (data[2]) {
						let timeOnServer = now - data[2];
						let hours = Math.floor(timeOnServer / 60 / 60);
						let minutes = Math.floor(timeOnServer / 60) % 60;
						let seconds = timeOnServer % 60;

						timeString = `${hours}:${minutes < 10 ? `0${minutes}` : minutes}:${seconds < 10 ? `0${seconds}` : seconds}`;
					}

					let currentStatus = "Connecting";
					maxNameLength    = Math.max(maxNameLength, data[0].length);
					maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
					maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
					maxStatus        = Math.max(maxStatus, currentStatus.length);

					rows.push([data[0], data[1], timeString, currentStatus]);
				}

				for (let i = 0; i < packet.players.length; i++) {
					let data = packet.players[i];

					if (data.name == undefined) data.name = "[no name received?]";
					if (data.steamid == undefined) data.steamid = "[no steamid received?]";

					let timeString = 'Unknown';
					if (data.jointime) {
						let timeOnServer = Math.round(data.jointime);
						let hours = Math.floor(timeOnServer / 60 / 60);
						let minutes = Math.floor(timeOnServer / 60) % 60;
						let seconds = timeOnServer % 60;

						timeString = `${hours}:${minutes < 10 ? `0${minutes}` : minutes}:${seconds < 10 ? `0${seconds}` : seconds}`;
					}

					let currentStatus = "Active";
					if (data.afktime) {
						let timeAFK = now - data.afktime;
						let hours = Math.floor(timeAFK / 60 / 60);
						let minutes = Math.floor(timeAFK / 60) % 60;
						let seconds = timeAFK % 60;

						currentStatus = `AFK for ${hours}:${minutes < 10 ? `0${minutes}` : minutes}:${seconds < 10 ? `0${seconds}` : seconds}`;
					}

					maxNameLength    = Math.max(maxNameLength, data.name.length);
					maxSteamidLength = Math.max(maxSteamidLength, data.steamid.length);
					maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
					maxStatus        = Math.max(maxStatus, currentStatus.length);

					rows.push([data.name, data.steamid, timeString, currentStatus]);
				}

				let linesOfText = [
					`| ${name + ' '.repeat(maxNameLength - name.length)} | ${steamid + ' '.repeat(maxSteamidLength - steamid.length)} | ${joined + ' '.repeat(maxJoinTimestamp - joined.length)} | ${status + ' '.repeat(maxStatus - status.length)} |`,
					`|${'-'.repeat(maxNameLength + 2)}|${'-'.repeat(maxSteamidLength + 2)}|${'-'.repeat(maxJoinTimestamp + 2)}|${'-'.repeat(maxStatus + 2)}|`
				];

				for (let i = 0; i < rows.length; i++) {
					let row = rows[i];
					linesOfText.push(`| ${row[0] + ' '.repeat(maxNameLength - row[0].length)} | ${row[1] + ' '.repeat(maxSteamidLength - row[1].length)} | ${row[2] + ' '.repeat(maxJoinTimestamp - row[2].length)} | ${row[3] + ' '.repeat(maxStatus - row[3].length)} |`);
				}

				const numplayers = packet.players.length +  packet.connectingPlayers.length

				let serverText = `**${packet.hostname}**\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${packet.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
				
				if (statuscount < relaySockets.length) {
					statustext = statustext ? statustext + '\n\n' + serverText : serverText;
					statuscount++;
				} else {
					replyInteraction.editReply((statustext ? statustext + '\n\n' : '') + serverText).then(() => replyInteraction = undefined);
				}
			} break;


			
			case "init": {
				if (packet.id.length > 0) {
					ws.id = packet.id
					console.log(ws.id)
				};
			} break;
        }
    }

    // Made it to the end of the queue, clear it
    queue = [];
    runningQueue = false;
}

// getWebhook creates a webhook object if it can't find one that was stored.
function getWebhook(json) {
    if (!client.isReady()) 
        return;

    client.fetchWebhook(webhookData.Webhook.ID, webhookData.Webhook.Token)
        .then(wh => {
            assignWebhook(wh);
            if (json == true) {
                let webhookOptions = {
                    username: "Websocket Status",
                    content: "Bot started. "
                }

                if (existsSync('./error.txt')) {
                    webhookOptions.content += `Bot has just restarted from a crash:\`\`\`\n${readFileSync('./error.txt')}\`\`\``;
                    unlink('./error.txt', error => {
                        if (error) {
                            console.log("Unable to delete error.txt. Previous crash report will reprint on next restart unless you manually delete the file");
                            console.error(error);
                        }
                    });
                }
                
                webhookOptions.content += "Awaiting server connection...";
                wh.send(webhookOptions);
            }
        })
        .catch(() => {
            // Make a new webhook
            if (webhookData.ChannelID.length === 0)
                return console.log("Tried to create a webhook, but no channel has been set yet.");

            let channel = client.channels.resolve(webhookData.ChannelID);
            if (channel) {
                channel.createWebhook({
                    name: "Dickord Communication Relay"
                }).then(wh => {assignWebhook(wh); saveIds();});
            }
        });

    if (webhook && json) {
        if (json instanceof Array) { // When the gmod server loses connection to the websocket, it stores them in an array and sends them all when connection is reestablished
            for (let i = 0; i < json.length; i++) {
                queue.push(json[i]);
            }
            sendQueue();
        } else if (json instanceof Object) {
            queue.push(json);
            sendQueue();
        }
    }
}

// Websocket server stuff
let webhook;
let relaySockets = []; // Array to hold multiple WebSocket connections

wss.shouldHandle = req => {
    let ip = req.socket.remoteAddress;
    if (ip === "127.0.0.1") 
        ip = "localhost";

    let accepting = ip === config.ServerIP;

    logConnection(ip, accepting);
    
    return accepting;
};

wss.on('connection', async ws => {
    relaySockets.push(ws); // Add new connection to the array

    if (webhook) {
        webhook.send({
            username: "Websocket Status",
            content: "Connection to server established."
        });
    }

    ws.on('message', buf => {
        let json;
        try {
            json = JSON.parse(buf.toString());
        } catch(err) {
            console.log("Invalid JSON received from server.");
        }

        if (!webhook) {
            getWebhook(json);
        } else {
            if (json instanceof Array) { // From a queue of messages from a lost connection
                for (let i = 0; i < json.length; i++) {
                    queue.push(json[i]);
                }
                sendQueue(ws);
            } else if (json instanceof Object) {
                queue.push(json);
                sendQueue(ws);
            }
        }
    });

    ws.on('error', error => {
        console.log("Error occurred in relay socket");
        console.error(error);

        if (webhook) {
            webhook.send({
                username: "Error Reporting",
                content: `Error occurred in the relay socket:\`\`\`\n${error.stack}\`\`\``
            });
        }
    });

    ws.on('close', () => {
        console.log("Connection to server closed.");

        // Remove the closed socket from the array
        relaySockets = relaySockets.filter(socket => socket !== ws);

        if (webhook) {
            webhook.send({
                username: "Websocket Status",
                content: "Connection to server closed. Awaiting reconnect..."
            });
        }
    });
});

wss.on('error', async err => {
    console.log('Error occurred in websocket server:');
    console.error(err);

    if (webhook) {
        await webhook.send({
            username: "Error Reporting",
            content: `Error occurred in websocket server:\`\`\`\n${err.stack}\`\`\`Restarting...`
        });
    }
    process.exit();
});

wss.on('close', async () => {
    console.log("Websocket server closed. What the..");
    if (webhook) {
        await webhook.send({
            username: "Error Reporting",
            content: "Websocket server closed for an unknown reason. Restarting..."
        });
    }
    process.exit();
});

// Functions for eval (js)

// Hides certain config values to prevent exposing private keys
function sanitizePrivateValues(str) {
    let newString = str.replaceAll(config.DiscordBotToken, "[Bot Token Hidden]");
    if (config.SteamAPIKey.length > 0) 
        newString = newString.replaceAll(config.SteamAPIKey, "[Steam API Key Hidden]");
    if (webhookData.Webhook.Token.length > 0) 
        newString = newString.replaceAll(webhookData.Webhook.Token, "[Webhook Token Hidden]");
    
    return newString;
}

// This is hacky, you probably should not do this. This temporarily overwrites console.log in the eval dev command to allow logging output at stages
let normalConsoleLog = console.log;
let temporaryLogs = [];
function log() {
    temporaryLogs.push(sanitizePrivateValues(Array.from(arguments).join(" ")));
}
function overwriteConsoleLog() {
    temporaryLogs = [];
    console.log = log;
}
function revertConsoleLog() {
    console.log = normalConsoleLog;
}

// Discord stuff
client.on('messageCreate', async message => {
    if (message.author.bot)
        return; // Do nothing for bots

    let ranCommand = false;
    if (config.Managers.includes(message.author.id) && message.content.trimStart().startsWith(config.ManagerCommandPrefix)) {
        let inputText = message.content.trimStart().slice(config.ManagerCommandPrefix.length);
        let command = inputText.split(' ', 1)[0].toLowerCase();
        inputText = inputText.slice(command.length).trim();

        ranCommand = true;
        switch (command) {
            case "setgmodchannel": {
                webhookData.ChannelID = message.channel.id;
                saveIds();
                message.react('✅');
            } break;

            case "restart":
            case "shutdown": {
                message.react('✅').then(() => process.exit()).catch(() => process.exit());
            } break;

            case "console":
            case "cmd":
            case "concommand":
            case "c":
            case "command": {
                // Send command to all relay sockets
                relaySockets.forEach(socket => {
                    if (socket.readyState === 1) {
                        let packet = {
                            type: "concommand",
                            from: message.member.displayName,
                            command: inputText
                        };
                        socket.send(Buffer.from(JSON.stringify(packet)));
                    }
                });
                message.react('✅');
            } break;

            case "eval":
            case "evaluate":
            case "js_run": {
                inputText = inputText.replace(/```(js)?/g, '');
                if (inputText.length === 0) 
                    return message.reply('Invalid input. Please provide JavaScript code to run.');
                
                try {
                    overwriteConsoleLog();
                    let result = eval(inputText);
                    revertConsoleLog();

                    let newMessageObject = {files: []};

                    if (temporaryLogs.length > 0) {
                        newMessageObject.files.push({attachment: Buffer.from(temporaryLogs.join('\n')), name: "console.txt"});
                    }

                    if (result === undefined || result === null) newMessageObject.content = "Evaluated successfully, no output.";
                    else if (result instanceof Object || result instanceof Array) result = JSON.stringify(result, null, 2);
                    else if (typeof result !== "string") result = result !== undefined ? result.toString() : "";

                    if (!newMessageObject.content) {
                        if (result.length > 256) {
                            newMessageObject.content = `Evaluated without error.`;
                            newMessageObject.files.push({attachment: Buffer.from(sanitizePrivateValues(result)), name: "result.txt"});
                        } else {
                            newMessageObject.content = `Evaluated without error.\`\`\`\n${sanitizePrivateValues(result)}\`\`\``;
                        }
                    }

                    message.reply(newMessageObject);
                } catch (error) {
                    let newMessageObject = {
                        content: `An error occurred while evaluating that code.\`\`\`\n${sanitizePrivateValues(error.stack)}\`\`\``
                    };
                    if (temporaryLogs.length > 0) {
                        newMessageObject.files = [{attachment: Buffer.from(temporaryLogs.join('\n')), name: "console.txt"}];
                    }
                    message.reply(newMessageObject);
                }
            } break;

            default: {
                ranCommand = false;
            } break;
        }        
    } 

    if (ranCommand) return;
    if (message.channel.id !== webhookData.ChannelID || message.system) return;
    if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) return message.react('⚠️');

    if (message.cleanContent.length > config.MaxMessageLength) return message.react('❌');

    let lines = message.content.split('\n');
    if (lines.length > config.LineBreakLimit) return message.react('❌');
    
    let packet = {
        type: "message",
        color: message.member.displayHexColor,
        author: message.member.displayName,
        content: message.cleanContent || "[attachment]"
    };

    if (message.reference) {
        try {
            let reference = await message.fetchReference();
            if (reference.member) {
                packet.replyingTo = {
                    author: reference.member.displayName,
                    color: reference.member.displayHexColor
                }
            } else if (reference.author) {
                if (reference.author.id === client.user.id || reference.author.id === webhookData.Webhook.ID) {
                    packet.replyingTo = {author: reference.author.username}
                } else {
                    try {
                        let member = await message.guild.members.fetch(reference.author.id);
                        if (member) {
                            packet.replyingTo = {
                                author: member.displayName,
                                color: member.displayHexColor
                            }
                        } else {
                            packet.replyingTo = {author: reference.author.username}
                        }
                    } catch (_) {
                        packet.replyingTo = {author: reference.author.username}
                    }
                }
            }
        } finally {}
    }

    relaySockets.forEach(socket => {
        if (socket.readyState === 1) {
            socket.send(Buffer.from(JSON.stringify(packet)));
        }
    });
});

var statustext = ""
var statuscount = 1

client.on('interactionCreate', interaction => {
    if (interaction.isCommand() && interaction.commandName === "status") {
        if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
            return interaction.reply('There is currently no connection to the server. Unable to request status.\nThe server automatically reconnects when an event happens, such as a player joining/leaving, or sending a message on the server.');

        interaction.reply('Requesting server status...').then(() => {
            if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
                return interaction.editReply('Websocket is not connected.');

            replyInteraction = interaction;
            let packet = {
                type: "status",
                from: interaction.member.displayName,
                color: interaction.member.displayHexColor,
				time: Math.floor(Date.now() / 1000),
            };
			
			statustext = ""
		    statuscount = 1
			
			
            relaySockets.forEach(socket => {
                if (socket.readyState === 1) {
                    socket.send(Buffer.from(JSON.stringify(packet)));
                }
				
				statusTimeout[socket.id] = setTimeout(() => {

					sendCommand('status',socket.id)
						.then(response => {
							
							
							const statustable = parseStatusData(response);
							
							let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

							let maxNameLength    = name.length;
							let maxSteamidLength = steamid.length;
							let maxJoinTimestamp = joined.length;
							let maxStatus        = status.length;

							let rows = [];

							let now = Math.round(Date.now() / 1000);
							for (let i = 0; i < statustable.spawningPlayers.length; i++) {
								let data = statustable.spawningPlayers[i];

								let timeString = data.timeConnected;

								let currentStatus = "Connecting";
								maxNameLength    = Math.max(maxNameLength, data[0].length);
								maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
								maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
								maxStatus        = Math.max(maxStatus, currentStatus.length);

								rows.push([data[0], data[1], timeString, currentStatus]);
							}

							for (let i = 0; i < statustable.activePlayers.length; i++) {
								let data = statustable.activePlayers[i];

								if (data.name == undefined) data.name = "[no name received?]";
								if (data.steamid == undefined) data.steamid = "[no steamid received?]";

								let timeString = statustable.activePlayers.timeConnected;

								let currentStatus = "Active";

								maxNameLength    = Math.max(maxNameLength, data[0].length);
								maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
								maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
								maxStatus        = Math.max(maxStatus, currentStatus.length);

								rows.push([data[0], data[1], timeString, currentStatus]);
							}

							let linesOfText = [
								`| ${name + ' '.repeat(maxNameLength - name.length)} | ${steamid + ' '.repeat(maxSteamidLength - steamid.length)} | ${joined + ' '.repeat(maxJoinTimestamp - joined.length)} | ${status + ' '.repeat(maxStatus - status.length)} |`,
								`|${'-'.repeat(maxNameLength + 2)}|${'-'.repeat(maxSteamidLength + 2)}|${'-'.repeat(maxJoinTimestamp + 2)}|${'-'.repeat(maxStatus + 2)}|`
							];

							for (let i = 0; i < rows.length; i++) {
								let row = rows[i];
								linesOfText.push(`| ${row[0] + ' '.repeat(maxNameLength - row[0].length)} | ${row[1] + ' '.repeat(maxSteamidLength - row[1].length)} | ${row[2] + ' '.repeat(maxJoinTimestamp - row[2].length)} | ${row[3] + ' '.repeat(maxStatus - row[3].length)} |`);
							}

							const numplayers = statustable.numPlayers;

							let serverText = `**${statustable.hostname}**\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
							
										
							if(statustext == ""){
								replyInteraction?.editReply(serverText);
								statustext = serverText;
								statuscount++;
							}else{
								replyInteraction?.editReply(statustext + '\n\n' + serverText);
							};
						})
						.catch(err => {
							if(statustext == ""){
								replyInteraction?.editReply("**" +socket.id + "**" + " Server is empty or unreachable.");
								statustext = "**" +socket.id + "**" + " Server is empty or unreachable.";
								statuscount++;
							}else{
								replyInteraction?.editReply(statustext + "\n\n" + "**" +socket.id + "**" + " Server is empty or unreachable.");
							};
						});
					clearTimeout(statusTimeout[socket.id])
				}, 700);
				
            });
		    
        });
    }
});

client.on('ready', () => {
    console.log("Bot initialized");

    getWebhook(true);

    client.application.commands.set([{
        name: "status",
        description: "View how many players are on the server along with the map."
    }]);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error(reason);
    if (client.isReady() && webhook) {
        await webhook.send({
            username: "Error Reporting",
            content: `Unhandled promise rejection:\`\`\`\n${reason.stack}\`\`\``
        });
    }
});

process.on('uncaughtException', (error, origin) => {
    if (origin !== "uncaughtException") return;
    
    console.error(error);
    writeFileSync('./error.txt', error.stack);
    process.exit();
});

client.login(config.DiscordBotToken);
