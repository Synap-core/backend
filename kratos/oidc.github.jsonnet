local claims = {
  email: '',
  name: '',
  login: '',
};

{
  identity: {
    traits: {
      email: claims.email || claims.login + '@github.local',
      name: claims.name || claims.login,
    },
  },
}

