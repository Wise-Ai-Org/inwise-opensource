// Chakra overlays and the CSS desktop share the approved Owl roles.
const brand = { 50:'#f0f6f4',100:'#e9f2ee',200:'#a8cfc1',300:'#61b2b0',400:'#0f7894',500:'#0f7894',600:'#09647d',700:'#013d54',800:'#013d54',900:'#09306a' };
export const owlTheme = {
  config: { initialColorMode: 'light', useSystemColorMode: false },
  fonts: { body: 'var(--font-ui)', heading: 'var(--font-story)' },
  fontSizes: { xs:'12px',sm:'13px',md:'15px',lg:'18px',xl:'18px','2xl':'18px','3xl':'18px' },
  colors: {
    brand, brandScheme:brand, brandTabs:brand, teal:brand,
    navy:{50:'#ffffff',100:'#f0f6f4',200:'#dbe4e7',300:'#b8cbd1',400:'#688b98',500:'#557e8c',600:'#335f70',700:'#2f6375',800:'#013d54',900:'#013d54'},
    gray:{50:'#ffffff',100:'#f0f6f4',200:'#dbe4e7',300:'#b8cbd1',400:'#688b98',500:'#557e8c',600:'#335f70',700:'#2f6375',800:'#013d54',900:'#013d54'},
    secondaryGray:{100:'#f0f6f4',200:'#dbe4e7',300:'#ffffff',400:'#b8cbd1',500:'#688b98',600:'#557e8c',700:'#335f70',800:'#335f70',900:'#013d54'},
  },
  styles:{global:{body:{bg:'white',color:'navy.900',fontFamily:'var(--font-ui)'},input:{color:'navy.900'}}},
  components:{
    Modal:{baseStyle:{dialog:{bg:'white',color:'navy.900',borderRadius:'16px'}}},
    Drawer:{baseStyle:{dialog:{bg:'white',color:'navy.900'}}},
    Button:{baseStyle:{borderRadius:'4px',fontSize:'13px'}},
    Input:{baseStyle:{field:{fontSize:'13px',borderRadius:'4px'}}},
    Textarea:{baseStyle:{fontSize:'13px',borderRadius:'4px'}},
    Select:{baseStyle:{field:{fontSize:'13px',borderRadius:'4px'}}},
    Card:{baseStyle:{borderRadius:'8px',boxShadow:'none'}},
  },
};
