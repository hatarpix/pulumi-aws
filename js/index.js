
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

const availabilityZones = ["us-east-1a", "us-east-1b", "us-east-1c"];
const dnsZoneName = "aws.domain.com";
const suffix = "dev";
const instanceType = "t3a.small";
const instancePrefix = "k8s-dev";


const DNSzone = aws.route53.getZone({ name: dnsZoneName });

// Create a VPC.
const vpc = new aws.ec2.Vpc(`vpc-${suffix}`, {
    cidrBlock: "10.90.0.0/16",
    tags: {
        Name: `vpc-${suffix}`, // Set the Name tag
    },
});

// Create an an internet gateway.
const gateway = new aws.ec2.InternetGateway(`gateway-${suffix}`, {
    vpcId: vpc.id,
    tags: {
        Name: `gateway-${suffix}`, // Set the Name tag
    },
});

// Create a route table.
const routes = new aws.ec2.RouteTable(`routes-${suffix}`, {
    vpcId: vpc.id,
    routes: [
        {
            cidrBlock: "0.0.0.0/0",
            gatewayId: gateway.id,
        },
    ],
    tags: {
        Name: `routes-${suffix}`, // Set the Name tag
    },
});

// Create a subnet that automatically assigns new instances a public IP address.

const subnets = availabilityZones.map((az, index) => {
    const subnet = new aws.ec2.Subnet(`subnet-${suffix}-${az}`, {
        availabilityZone: az,
        cidrBlock: `10.90.${index + 1}.0/24`, // Adjust the CIDR block as needed
        vpcId: vpc.id,
        mapPublicIpOnLaunch: true,
        tags: {
            Name: `subnet-${suffix}-${az}`, // Set the Name tag
        },
    });

    const routeTableAssociation = new aws.ec2.RouteTableAssociation(`route-table-assoc-${az}`, {
        subnetId: subnet.id,
        routeTableId: routes.id,
    });

    return subnet;
});


// Create a security group allowing inbound access over port 80 and outbound
// access to anywhere.
const securityGroupSSH = new aws.ec2.SecurityGroup("ALL_ssh", {
    vpcId: vpc.id,
    egress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
        },
    ],
    ingress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
        },
    ],
    tags: {
        Name: `ALL_ssh`, // Set the Name tag
    },
});
const securityGroupRule = new aws.ec2.SecurityGroupRule("ssh_group", {
    type: "ingress",
    securityGroupId: securityGroupSSH.id,
    sourceSecurityGroupId: securityGroupSSH.id,
    protocol: "All",
    fromPort: 0,
    toPort: 65535
});

const securityGroupHTTP = new aws.ec2.SecurityGroup("ALL_http", {
    vpcId: vpc.id,
    egress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
        },
    ],
    ingress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
        },
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
        },
    ],
    tags: {
        Name: `ALL_http`, // Set the Name tag
    },
});


const securityGroupK8S = new aws.ec2.SecurityGroup("ALL_k8s", {
    vpcId: vpc.id,
    egress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
        },
    ],
    ingress: [
        {
            cidrBlocks: [ "0.0.0.0/0" ],
            protocol: "tcp",
            fromPort: 16443,
            toPort: 16443,
        },
    ],
    tags: {
        Name: `ALL_k8s`, // Set the Name tag
    },
});

// Create an IAM role for EC2 instances
let ecrPolicy = pulumi.output(aws.iam.getPolicyDocument({
    statements: [{
        actions: [
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:GetRepositoryPolicy",
            "ecr:DescribeRepositories",
            "ecr:ListImages",
            "ecr:DescribeImages",
            "ecr:BatchGetImage",
            "ecr:GetLifecyclePolicy",
            "ecr:GetLifecyclePolicyPreview",
            "ecr:ListTagsForResource",
            "ecr:DescribeImageScanFindings"
        ],
        resources: ["*"],
    }],
}, { async: true }));

let ec2Role = new aws.iam.Role("ec2-Role-k8s", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: "sts:AssumeRole",
                Principal: {
                    Service: "ec2.amazonaws.com",
                },
                Effect: "Allow",
                Sid: "",
            },
        ],
    }),
});

let rolePolicyAttachment = new aws.iam.RolePolicy("ecrPolicy", {
    role: ec2Role.name,
    policy: ecrPolicy.json,
});

let instanceProfile = new aws.iam.InstanceProfile("ec2-Profile-k8s", {
    role: ec2Role.name
});

// Example
let s3Bucket = new aws.s3.Bucket("k8s-logs");
let bucketPolicy = new aws.iam.RolePolicy("bucketPolicy", {
    role: ec2Role.id,
    policy: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "s3:GetObject",
                    "s3:ListBucket",
                    "s3:PutObject"
                ],
                "Resource": [
                    "${s3Bucket.arn}",
                    "${s3Bucket.arn}/*"
                ]
            }
        ]
    }`
});


// Find the latest Ubuntu Linux AMI.
const ami = pulumi.output(aws.ec2.getAmi({
    owners: ["099720109477"], // Canonical
    mostRecent: true,
    filters: [
        { name: "name", values: [ "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" ] },
    ],
}));

// Create the key pair
const keyPair = new aws.ec2.KeyPair("adminaws-keypair", {
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWO9EKfPEQCbFV9VGl/GCp1cRfEugz/Yr36ch6yKd4p admin",
});

// Define the user data for the instance
//   This script runs when the instance is launched
//   The script will perform an update and upgrade in the background
const userData = `#!/bin/bash
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
mkdir -p /var/snap/microk8s/common/
cat <<EOT >> /var/snap/microk8s/common/.microk8s.yaml 
---
version: 0.1.0
addons:
  - name: dns
  - name: rbac
  - name: ingress
  - name: cert-manager
extraSANs:
  - k8s.${dnsZoneName}
EOT
snap install microk8s --classic --channel=1.28
snap install aws-cli --classic
usermod -a -G microk8s ubuntu
chown -f -R ubuntu /home/ubuntu/.kube
sed -i 's/--cluster-dns=10.152.183.10/--cluster-dns=10.152.183.10,1.1.1.1,8.8.8.8/g' /var/snap/microk8s/current/args/kubelet
`;

// Create instances in different availability zones
const instances = [];
for (let i = 0; i < availabilityZones.length; i++) {
    const az = availabilityZones[i];
    const instance = new aws.ec2.Instance(`${instancePrefix}-${i}`, {
        instanceType: instanceType,
        ami: ami.id,
        subnetId: subnets[i].id,
        keyName: keyPair.id,
        vpcSecurityGroupIds: [
            securityGroupSSH.id,
            securityGroupHTTP.id,
            securityGroupK8S.id,
        ],
        tags: {
            Name: `${instancePrefix}-${i}`, // Set the Name tag
        },
        rootBlockDevice: {
            volumeSize: 30,
            volumeType: "gp3", // Set the volume type to gp3
        },
        iamInstanceProfile: instanceProfile.name,
        userData: userData,
      });
    instances.push(instance);
}

/////////////////////////////////////////////////////////////////////////
// Create a Network Load Balancer
const networkLoadBalancer = new aws.lb.LoadBalancer(`NLB-${suffix}`, {
    internal: false,
    ipAddressType: "ipv4",
    loadBalancerType: "network",
    enableCrossZoneLoadBalancing: true,
    subnets: subnets.map(subnet => subnet.id),
    enableDeletionProtection: false,
    name: `NLB-${suffix}`,
    tags: {
        Name: `NLB-${suffix}`,
    },
});

// Create listeners
const listeners = [
    { port: 16443, protocol: "TCP" },
    { port: 80, protocol: "TCP" },
    { port: 443, protocol: "TCP" },
];

listeners.forEach(listener => {

    const targetGroup = new aws.lb.TargetGroup(`targetGroup-${listener.port}`, {
        port: listener.port,
        protocol: "TCP",
        targetType: "instance",
        vpcId: vpc.id,
        healthCheck: {
            enabled: true,
            interval: 30,
            port: listener.port,
            protocol: "TCP",
            timeout: 5,
        },
        tags: {
            Name: `TargetGroup-${listener.port}`,
        },
    });

    // Register instances with the target group
    for (let i = 0; i < instances.length; i++) {
        new aws.lb.TargetGroupAttachment(`target-${listener.port}-${i}`, {
            targetGroupArn: targetGroup.arn,
            targetId: instances[i].id,
            port: listener.port,
        });
    }

    new aws.lb.Listener(`listener-${listener.port}`, {
        loadBalancerArn: networkLoadBalancer.arn,
        port: listener.port,
        protocol: listener.protocol,
        defaultActions: [
            {
                type: "forward",
                targetGroupArn: targetGroup.arn,
            },
        ],
    });
});

//Add NLB to DNS
const NLBRecord = new aws.route53.Record(`NLB-record`, {
    name: `k8s`,
    type: "CNAME",
    zoneId: DNSzone.then(DNSzone => DNSzone.zoneId),
    records: [networkLoadBalancer.dnsName],
    ttl: 300, // Time to live for DNS record
    allowOverwrite: true,
});
/////////////////////////////////////////////////////////////////

// Add hosts to DNS
const inst = instances.map((instance, index) =>{
    const clusterRecord = new aws.route53.Record(`nodeRecord-${index}`, {
        name: instance.urn.apply(urn => urn.split("::")[3]),
        type: "A",
        zoneId: DNSzone.then(DNSzone => DNSzone.zoneId),
        records: [instance.publicIp],
        ttl: 300, // Time to live for DNS record
        allowOverwrite: true,
    });
})

// Print data
const inst_show = instances.map((instance, index) =>{
    pulumi.all([instance.tags, instance.id, instance.publicIp, instance.availabilityZone, instance.privateIp]).apply(([tags, id, ip, az, ip2]) => {
        const inst = JSON.stringify({name: tags["Name"], id: id, ip: ip, az: az, PrivateIP: ip2 });
    
        console.log(`instance: ${inst}`);

    })
})