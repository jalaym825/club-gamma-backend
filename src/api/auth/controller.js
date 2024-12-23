const logger = require('../../utils/Logger');
const mailer = require('../../utils/Mailer');
const jwt = require('jsonwebtoken');
const { default: axios } = require('axios');
const prisma = require("../../utils/PrismaClient");

const getUser = async (req, res, next) => {
    try {
        const user = req.user;
        if (!user) {
            logger.warn(`[/auth/getUser] - user not found`);
            logger.debug(`[/auth/getUser] - user: ${req.user.sys_id}`);
            return next({ path: '/auth/getUser', status: 400, message: "User not found" })
        }
        logger.info(`[/auth/getUser] - success - ${user.sys_id}`);
        logger.debug(`[/auth/getUser] - user: ${user.sys_id}`);
        delete user.password;
        delete user.sys_id;
        return res.status(200).json({
            user,
        });
    } catch (err) {
        next({ path: '/auth/getUser', status: 400, message: err.message, extraData: err });
    }
}

const logout = async (req, res, next) => {
    try {
        res.clearCookie('token');
        return res.status(200).json({
            message: "Logged out successfully"
        });
    } catch (err) {
        next({ path: '/auth/logout', status: 400, message: err.message, extraData: err });
    }
}

const githubCallback = async (req, res, next) => {
    const user = req.user;
    const token = jwt.sign({ id: user.githubId }, process.env.JWT_SECRET, {
        expiresIn: "7d",
    });

    logger.info(`[/auth/github/callback] - Successfully authenticated user: ${user.sys_id}`);

    // Redirect to frontend
    res.redirect(process.env.FRONTEND_URL+"/redirect/"+token);
}

const getAccessToken = async (req, res, next) => {
    try {
        const code = req.query.code;
        console.log('Received code:', code);

        const params = `client_id=${process.env.GITHUB_CLIENT_ID}&client_secret=${process.env.GITHUB_CLIENT_SECRET}&code=${code}`;

        const response = await axios.post('https://github.com/login/oauth/access_token?' + params, null, {
            headers: {
                'Accept': 'application/json'
            }
        });

        console.log('Token response:', response.data);

        const accessToken = response.data.access_token;
        if (!accessToken) {
            throw new Error('No access token received from GitHub');
        }

        // Get the user data
        let ghUser;
        try {
            const userResponse = await axios.get('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            });
            ghUser = userResponse.data;
            console.log('GitHub user data:', ghUser);
        } catch (error) {
            console.error('Error fetching user data:', error.response?.data || error.message);
            throw new Error('Failed to fetch user data from GitHub');
        }

        let user = await prisma.users.findFirst({
            where: {
                githubId: ghUser.login
            }
        });

        if (!user || !user.email) {
            console.log('User not found, creating new user');
            try {
                const emailResponse = await axios.get('https://api.github.com/user/emails', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    }
                });
                console.log('Email response:', emailResponse.data);

                const primaryEmail = emailResponse.data.find(email => email.primary)?.email || emailResponse.data[0]?.email;
                const universityEmail = emailResponse.data.find(email => email.email.includes('charusat.edu.in'))?.email || null;

                user = await prisma.users.upsert({
                    where: {
                        githubId: ghUser.login
                    },
                    create: {
                        githubId: ghUser.login,
                        email: primaryEmail,
                        universityEmail: universityEmail,
                        name: ghUser.name?ghUser.name:ghUser.login,
                    },
                    update: {
                        email: primaryEmail,
                        universityEmail: universityEmail,
                    }
                });
                await mailer.sendGreetingMail(primaryEmail, user.name);
            } catch (error) {
                console.error('Error fetching or processing emails:', error.response?.data || error.message);
                throw new Error('Failed to fetch or process user emails');
            }
        }

        const token = jwt.sign({ id: user.githubId }, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        return res.status(200).json({
            token,
        });
    } catch (err) {
        console.error('Error in getAccessToken:', err);
        next({ path: '/auth/getAccessToken', status: 400, message: err.message, extraData: err });
    }
};
module.exports = {
    getUser,
    logout,
    githubCallback,
    getAccessToken
}
