const jwt = require('jsonwebtoken');
const path = require('path');
//const config = require('config');
const app = require('express')();
app.set('jwtPrivateKey', '12345');
const { IdentityService } = require('fabric-ca-client'); // For adding affiliation to user and also fetch user from IdentityService
const { Gateway, Wallets } = require('fabric-network');
const { User } = require('fabric-client');

const generateAffiliation = require('./generateAffiliation.js');

/**
 * The algorithm(s) provided by MyNetwork class:
 * A. Get the card using its data, then return its name. (importCardToNetwork)
 * B. Methods to connect, ping, disconnect to/from the "Business Network" 
        - To be replaced by "gateway.connect()" and such gateway methods.
 * C. Generate a JWT token which encapsulates and then encrypts the payload using jwt.sign(payload, privKey) 
 */
/**
 * Initiliaze a Fabric Network.
 * @param channelName The name of channel we are currently performing the transaction on.
 * @param chaincodeName The name of chaincode which we are using to perform the transaction.
 */
class MyNetwork{
    constructor(channelName, chaincodeName, cardName) {
        this.channelName = channelName;
        this.chaincodeName = chaincodeName;
        this.caName = 'ca.org1.example.com';
        this.mspId = 'Org1MSP'
        this.connection = new Gateway();
    }
    /**
     * Get the common connection profile from JSON to the JS object structure.
     * @returns {object} Common Connection Profile (ccp) object
     */
    getCCP() {
        try {
            // load the network configuration
            const ccpPath = path.resolve(__dirname, '..', 'fabric-artifacts', 'hlf-connection-profile.json');
            const ccpJSON = fs.readFileSync(ccpPath, 'utf8')
            const ccp = JSON.parse(ccpJSON);
            return ccp;
        } catch(err) {
            console.log("[ERROR] Could not fetch connection profile: \n", err);
        }
    }
    async getFSWallet() {
        try {
            const fsWalletPath =  path.resolve(process.cwd(),'..', 'wallet'); // process.cwd() = current working directory
            if (!fs.existsSync(fsWalletPath)){
                fs.mkdirSync(fsWalletPath);
            }
            const wallet = await Wallets.newFileSystemWallet(fsWalletPath);
            console.log(`Wallet path: ${walletPath}`);
            return wallet;
        } catch(err){
            console.log("[ERROR] Could not set wallet: \n", err);   
        }
    }
    async getRegisteredUser(username, pType, pIdentifier){
        /**
         * Algorithm:
         *  0. Get CA as an object to work with, with help of CCP.
         * If Identity is present,
         *  1. Get the identity from the wallet (if already registered) and return the identity.
         * If identity is absent,
         *  1. Check if admin identity is registered and enrolled (logged in)
         *  2. We fetch the Identity from wallet using IdentityProvider.
         *  3. Register the user.
         *  4. Enroll the user.
         *  5. Put the user into Wallet.
        */
        // Step 0: Create a new CA client for interacting with the CA.
        const caURL = this.getCCP().certificateAuthorities[this.caName].url;
        const ca = new FabricCAServices(caURL);

        // Step 1:
        const wallet = this.getFSWallet();
        const userIdentity = await wallet.get(username);
        if (userIdentity) {
            console.log(`An identity for the user ${username} already exists in the wallet`);
            var response = {
                identity: userIdentity,
                message: username + ' enrolled Successfully',
            };
            return response
        }

        // Step 1 (when identity is absent):
        // Check to see if we've already enrolled the admin user.
        let adminIdentity = await wallet.get('admin');
        if (!adminIdentity) {
            console.log('An identity for the admin user "admin" does not exist in the wallet. Creating one...');
            await this._enrollAdmin(wallet);
            adminIdentity = await wallet.get('admin');
            console.log("OBSERVE -> admin identity: ",adminIdentity);
            console.log("Admin Enrolled Successfully")
        }

        // build a user object for authenticating with the CA

        // v1.4 method to obtain user via wallet:
        // const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        // const adminUser = await provider.getUserContext(adminIdentity, 'admin');

        // v2.1/v2.2 method to obtain user:
        const adminUser = new User('admin'); // MUST be same as bootstrap identity's username given in docker-compose.yaml for CA.

        /**
        * CA User guide (very useful to practise the hands-on given on the site beforehand): 
        * https://hyperledger-fabric-ca.readthedocs.io/en/latest/users-guide.html
        */
        // Register the user, enroll the user, and import the new identity into the wallet.
        let affStr = generateAffiliation(orgName, deptName);
        const secret = await ca.register({ 
                affiliation: affStr.result, 
                enrollmentID: username, 
                role: 'client',
                attrs: [
                    {
                        name: 'pType',
                        value: pType,
                        ecert: true
                    },
                    {
                        name: 'pIdentifier',
                        value: pIdentifier,
                        ecert: true
                    },
                    {
                        name: 'hf.AffiliationMgr',
                        value: true,
                        ecert: true
                    },
                    {
                        name: 'hf.Registrar.Roles',
                        value: 'peer,client',
                        ecert: true
                    }
                ]
            }, adminUser);
        
        const enrollment = await ca.enroll({ enrollmentID: username, enrollmentSecret: secret });
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: this.mspId,
            type: 'X.509',
        };

        await wallet.put(username, x509Identity);
        console.log(`Successfully registered and enrolled admin user ${username} and imported it into the wallet`);

        const userIdentity = await wallet.get(username);
        const userObj = new User(username);
        var response = {
            identity: userIdentity,
            user: userObj,
            message: username + ' enrolled Successfully',
        };
        return response;
    }
    /**
     * Enroll Admin identity. Only to be called by getRegisteredUser() when required.
     * @private
     */
    async _enrollAdmin(wallet) {

        console.log('Enrolling admin...')

        try {
            const caInfo = ccp.certificateAuthorities[this.caName];
            const caTLSCACerts = caInfo.tlsCACerts.pem;
            const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

            // Check to see if we've already enrolled the admin user.
            const identity = await wallet.get('admin');
            if (identity) {
                console.log('An identity for the admin user "admin" already exists in the wallet');
                return;
            }

            // Enroll the admin user, and import the new identity into the wallet.
        
            // enrollmentID and enrollmentSecret MUST be the same as the bootstrap identity given via '-b' in docker-compose.yaml file 
            // for given 'ca.org1.example.com' container (ca-org1 service) or whichever CA we defined in 'this.caName'
            const enrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
            const x509Identity = {
                credentials: {
                    certificate: enrollment.certificate,
                    privateKey: enrollment.key.toBytes(),
                },
                mspId: this.mspId,
                type: 'X.509',
            };
            await wallet.put('admin', x509Identity);
            console.log('Successfully enrolled admin user "admin" and imported it into the wallet');
            return;
        } catch (error) {
            console.error(`Failed to enroll admin user "admin": ${error}`);
        }
    }
    
    /**
     * Some documentation links:
     * 1. Different event handler strategies: https://hyperledger.github.io/fabric-sdk-node/master/module-fabric-network.html#.DefaultEventHandlerStrategies
     * 2. Connection options docs: https://hyperledger.github.io/fabric-sdk-node/master/module-fabric-network.GatewayOptions.html
     */
    /**
     * Connects client to Fabric gateway.
     * @param {string|import('fabric-network').Identity} username Username of client 
     * @returns - Smart contract object
     */
    async connect(username){
        try{
            const ccp = this.getCCP();
            const connectOptions = {
                wallet, 
                identity: username, 
                discovery: { 
                    enabled: true,
                    asLocalhost: true 
                },
                eventHandlerOptions: {
                    strategy: DefaultEventHandlerStrategies.NETWORK_SCOPE_ALLFORTX
                }
            }  
            await this.connection.connect(ccp, connectOptions);
            return this.getContract();
        } catch(err){
            console.error("[ERROR] Could not connect to gateway: \n", err);
            throw new Error("[ERROR] Could not connect to gateway: \n" + err);
        }
    }
    /**
     * Fetch the smart contract object to perform invoke (submitTransaction) or query (evaluateTransaction) requests.
     * @returns {object} Smart contract object 
     */
    async getContract(){
        try {
            // Get the network (channel) our contract is deployed to.
            const network = await this.connection.getNetwork(this.channelName);
            const contract = network.getContract(this.chaincodeName);
            return contract;
        } catch(err) {
            console.error("[ERROR] Problem occured trying to fetch network / smart contract: \n",err);
            throw new Error("[ERROR] Problem occured trying to fetch network / smart contract: \n" + err);
        }
    }
    /**
     * Clears the fetched client identity from filesystem (wallet/)
     */
    async logout(){
    }
    /**
     * Disconnects client from Fabric Gateway.
     */
    async disconnect(){
        try {
            this.connection.disconnect();
        } catch(err) {
            console.error("[ERROR] Could not disconnect from gateway: \n", err);
            throw new Error("[ERROR] Could not disconnect from gateway: \n" + err);
        }
    } 
    
    generateAccesToken(){
        return new Promise((resolve,reject)=>{
            try {
                let privateKey = app.get("jwtPrivateKey");
                if(!privateKey){
                    console.log("Private key not found");
                
                }
                let identityService = new IdentityService(); 
                const token = jwt.sign({"cardName":idCardName,"pType":pType},privateKey)
                console.log(token);
                resolve(token);
            } catch(err){

            }
        })
    }
}

module.exports = MyNetwork; 