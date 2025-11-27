local claims = {
  email_verified: false,
  email: '',
  name: '',
};

{
  identity: {
    traits: {
      email: claims.email,
      email_verified: claims.email_verified,
      name: claims.name,
    },
  },
}

