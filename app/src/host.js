// The free GitHub address (username.github.io) is one shared storage space for every page under the same
// GitHub username, so data saved there could be read by your other pages. It is fine for trying the app with
// made-up data, not for real statements. Your own domain, on its own subdomain, does not have that problem.
export const isTestAddress = hostname => /(^|\.)github\.io$/i.test(hostname);
